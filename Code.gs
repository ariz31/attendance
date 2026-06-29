/**
 * Attendance Offline-Capable Apps Script Web App
 *
 * Backend responsibilities:
 * - Serve the HTML app.
 * - Initialize a Google Sheet database and Drive image folder.
 * - Receive compressed image payloads from the client.
 * - Store image files in Drive and metadata rows in Sheets.
 * - Keep sync idempotent using a client-generated record ID.
 */

const APP_CONFIG = {
  appName: 'Attendance Capture',
  sheetName: 'Attendance',
  settingsSheetName: 'Settings',
  driveFolderName: 'Attendance Images',
  maxBatchSize: 10,
  maxCompressedImageBytes: 5 * 1024 * 1024,
  headers: [
    'Record ID',
    'Server Timestamp',
    'Client Timestamp',
    'Name',
    'Class Code',
    'Title',
    'Image File ID',
    'Image URL',
    'Image MIME Type',
    'Original Size Bytes',
    'Compressed Size Bytes',
    'Compression Ratio',
    'Source Filename',
    'Device ID',
    'Status',
    'Notes'
  ]
};

const SCRIPT_PROPS = {
  spreadsheetId: 'SPREADSHEET_ID',
  folderId: 'IMAGE_FOLDER_ID'
};

function doGet(e) {
  const route = e && e.parameter && e.parameter.route ? String(e.parameter.route) : 'app';

  if (route === 'manifest') {
    return ContentService
      .createTextOutput(JSON.stringify(getManifest_()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_CONFIG.appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (error) {
    return '';
  }
}

function getManifest_() {
  return {
    name: APP_CONFIG.appName,
    short_name: 'Attendance',
    start_url: './',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#2563eb',
    description: 'Offline-capable attendance capture app backed by Google Sheets and Drive.',
    icons: []
  };
}

/**
 * First-run setup. Creates or links the Spreadsheet database and Drive folder.
 */
function setup() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const db = ensureDatabase_();
    writeSettings_(db.settingsSheet, {
      APP_NAME: APP_CONFIG.appName,
      SPREADSHEET_ID: db.spreadsheet.getId(),
      SPREADSHEET_URL: db.spreadsheet.getUrl(),
      IMAGE_FOLDER_ID: db.folder.getId(),
      IMAGE_FOLDER_URL: db.folder.getUrl(),
      LAST_SETUP_AT: new Date().toISOString()
    });

    return buildConfigResponse_(true, db);
  } finally {
    lock.releaseLock();
  }
}

function getAppConfig() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty(SCRIPT_PROPS.spreadsheetId);
  const folderId = props.getProperty(SCRIPT_PROPS.folderId);

  if (!spreadsheetId || !folderId) {
    return {
      configured: false,
      appName: APP_CONFIG.appName,
      message: 'Database has not been initialized yet.'
    };
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const folder = DriveApp.getFolderById(folderId);
    const sheet = getOrCreateSheet_(spreadsheet, APP_CONFIG.sheetName, APP_CONFIG.headers);
    const settingsSheet = getOrCreateSheet_(spreadsheet, APP_CONFIG.settingsSheetName, ['Key', 'Value']);

    return buildConfigResponse_(true, { spreadsheet, folder, sheet, settingsSheet });
  } catch (error) {
    return {
      configured: false,
      appName: APP_CONFIG.appName,
      message: 'Stored database connection could not be opened. Run setup again.',
      error: error.message
    };
  }
}

/**
 * Saves compressed attendance records. Intended for small batches from google.script.run.
 * Each record must include: id, name, classCode, title, imageBase64, mimeType.
 */
function saveAttendanceRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('Expected an array of attendance records.');
  }

  if (records.length === 0) {
    return { ok: true, saved: 0, results: [] };
  }

  if (records.length > APP_CONFIG.maxBatchSize) {
    throw new Error('Batch is too large. Send at most ' + APP_CONFIG.maxBatchSize + ' records at a time.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const db = ensureDatabase_();
    const existingIds = getExistingIds_(db.sheet);
    const rows = [];
    const results = [];

    records.forEach(function(record, index) {
      const fallbackId = record && record.id ? String(record.id) : 'record-' + index;

      try {
        const normalized = normalizeRecord_(record);

        if (existingIds[normalized.id]) {
          results.push({
            id: normalized.id,
            status: 'duplicate',
            message: 'Record already exists in the sheet.'
          });
          return;
        }

        const imageBlob = buildImageBlob_(normalized);
        const imageFile = db.folder.createFile(imageBlob);
        imageFile.setDescription('Attendance image for ' + normalized.name + ' / ' + normalized.classCode + ' / ' + normalized.title);

        const compressionRatio = normalized.originalSize > 0
          ? Number((normalized.compressedSize / normalized.originalSize).toFixed(4))
          : '';

        rows.push([
          normalized.id,
          new Date(),
          parseDateOrBlank_(normalized.clientTimestamp),
          normalized.name,
          normalized.classCode,
          normalized.title,
          imageFile.getId(),
          imageFile.getUrl(),
          normalized.mimeType,
          normalized.originalSize,
          normalized.compressedSize,
          compressionRatio,
          normalized.sourceFileName,
          normalized.deviceId,
          'synced',
          ''
        ]);

        existingIds[normalized.id] = true;
        results.push({
          id: normalized.id,
          status: 'synced',
          fileId: imageFile.getId(),
          imageUrl: imageFile.getUrl()
        });
      } catch (error) {
        results.push({
          id: fallbackId,
          status: 'error',
          message: error.message
        });
      }
    });

    if (rows.length > 0) {
      db.sheet
        .getRange(db.sheet.getLastRow() + 1, 1, rows.length, APP_CONFIG.headers.length)
        .setValues(rows);
    }

    return {
      ok: true,
      saved: rows.length,
      results: results
    };
  } finally {
    lock.releaseLock();
  }
}

function listRecentAttendance(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const db = ensureDatabase_();
  const lastRow = db.sheet.getLastRow();

  if (lastRow <= 1) {
    return [];
  }

  const rowCount = Math.min(safeLimit, lastRow - 1);
  const startRow = lastRow - rowCount + 1;
  const values = db.sheet.getRange(startRow, 1, rowCount, APP_CONFIG.headers.length).getValues();

  return values.reverse().map(function(row) {
    return {
      id: row[0],
      serverTimestamp: formatDateForClient_(row[1]),
      clientTimestamp: formatDateForClient_(row[2]),
      name: row[3],
      classCode: row[4],
      title: row[5],
      imageFileId: row[6],
      imageUrl: row[7],
      mimeType: row[8],
      originalSize: row[9],
      compressedSize: row[10],
      compressionRatio: row[11],
      sourceFileName: row[12],
      deviceId: row[13],
      status: row[14],
      notes: row[15]
    };
  });
}

function ensureDatabase_() {
  const spreadsheet = getOrCreateSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, APP_CONFIG.sheetName, APP_CONFIG.headers);
  const settingsSheet = getOrCreateSheet_(spreadsheet, APP_CONFIG.settingsSheetName, ['Key', 'Value']);
  const folder = getOrCreateImageFolder_();

  return { spreadsheet, sheet, settingsSheet, folder };
}

function getOrCreateSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(SCRIPT_PROPS.spreadsheetId);

  if (existingId) {
    try {
      return SpreadsheetApp.openById(existingId);
    } catch (error) {
      props.deleteProperty(SCRIPT_PROPS.spreadsheetId);
    }
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty(SCRIPT_PROPS.spreadsheetId, active.getId());
    return active;
  }

  const spreadsheet = SpreadsheetApp.create('Attendance PWA Database');
  props.setProperty(SCRIPT_PROPS.spreadsheetId, spreadsheet.getId());
  return spreadsheet;
}

function getOrCreateImageFolder_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(SCRIPT_PROPS.folderId);

  if (existingId) {
    try {
      return DriveApp.getFolderById(existingId);
    } catch (error) {
      props.deleteProperty(SCRIPT_PROPS.folderId);
    }
  }

  const folder = DriveApp.createFolder(APP_CONFIG.driveFolderName + ' - ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss'));
  props.setProperty(SCRIPT_PROPS.folderId, folder.getId());
  return folder;
}

function getOrCreateSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  ensureHeaders_(sheet, headers);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  const existingHeaderRange = sheet.getRange(1, 1, 1, headers.length);
  const existingHeaders = existingHeaderRange.getValues()[0];
  const hasAnyHeader = existingHeaders.some(function(value) { return value !== ''; });

  if (!hasAnyHeader) {
    existingHeaderRange.setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.autoResizeColumns(1, headers.length);
    return;
  }

  const missingOrChanged = headers.some(function(header, index) {
    return existingHeaders[index] !== header;
  });

  if (missingOrChanged) {
    existingHeaderRange.setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
}

function writeSettings_(settingsSheet, values) {
  const entries = Object.keys(values).map(function(key) {
    return [key, values[key]];
  });

  settingsSheet.clearContents();
  settingsSheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
  settingsSheet.getRange(2, 1, entries.length, 2).setValues(entries);
  settingsSheet.setFrozenRows(1);
  settingsSheet.autoResizeColumns(1, 2);
}

function getExistingIds_(sheet) {
  const result = {};
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return result;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  values.forEach(function(row) {
    const id = row[0];
    if (id) {
      result[String(id)] = true;
    }
  });

  return result;
}

function normalizeRecord_(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Invalid record payload.');
  }

  const normalized = {
    id: requiredString_(record.id, 'Record ID', 120),
    name: requiredString_(record.name, 'Name', 200),
    classCode: requiredString_(record.classCode, 'Class Code', 120),
    title: requiredString_(record.title, 'Title', 200),
    imageBase64: requiredString_(record.imageBase64, 'Image', APP_CONFIG.maxCompressedImageBytes * 2),
    mimeType: optionalString_(record.mimeType, 'image/jpeg', 80),
    sourceFileName: optionalString_(record.sourceFileName, 'attendance-image.jpg', 180),
    deviceId: optionalString_(record.deviceId, '', 120),
    clientTimestamp: optionalString_(record.clientTimestamp, '', 80),
    originalSize: safeNumber_(record.originalSize),
    compressedSize: safeNumber_(record.compressedSize)
  };

  if (!/^image\//i.test(normalized.mimeType)) {
    throw new Error('Uploaded file must be an image.');
  }

  if (normalized.compressedSize > APP_CONFIG.maxCompressedImageBytes) {
    throw new Error('Compressed image is too large. Maximum is ' + APP_CONFIG.maxCompressedImageBytes + ' bytes.');
  }

  return normalized;
}

function buildImageBlob_(record) {
  const parsed = parseBase64Image_(record.imageBase64, record.mimeType);

  if (parsed.bytes.length > APP_CONFIG.maxCompressedImageBytes) {
    throw new Error('Decoded compressed image is too large. Reduce image quality or dimensions.');
  }

  const extension = mimeTypeToExtension_(parsed.mimeType);
  const safeFilename = buildSafeFilename_(record, extension);
  return Utilities.newBlob(parsed.bytes, parsed.mimeType, safeFilename);
}

function parseBase64Image_(data, fallbackMimeType) {
  const value = String(data || '');
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = match ? match[1] : fallbackMimeType;
  const base64 = match ? match[2] : value;

  if (!base64) {
    throw new Error('Image data is empty.');
  }

  return {
    mimeType: mimeType || 'image/jpeg',
    bytes: Utilities.base64Decode(base64)
  };
}

function buildSafeFilename_(record, extension) {
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const name = sanitizeFilenamePart_(record.name);
  const classCode = sanitizeFilenamePart_(record.classCode);
  const title = sanitizeFilenamePart_(record.title);
  const id = sanitizeFilenamePart_(record.id).slice(0, 16);
  return [timestamp, classCode, name, title, id].filter(Boolean).join('_') + '.' + extension;
}

function sanitizeFilenamePart_(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function mimeTypeToExtension_(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.indexOf('png') !== -1) return 'png';
  if (normalized.indexOf('webp') !== -1) return 'webp';
  if (normalized.indexOf('gif') !== -1) return 'gif';
  return 'jpg';
}

function requiredString_(value, fieldName, maxLength) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(fieldName + ' is required.');
  }
  if (text.length > maxLength) {
    throw new Error(fieldName + ' is too long.');
  }
  return text;
}

function optionalString_(value, fallback, maxLength) {
  const text = String(value || fallback || '').trim();
  return text.slice(0, maxLength);
}

function safeNumber_(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseDateOrBlank_(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : date;
}

function formatDateForClient_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value);
}

function buildConfigResponse_(configured, db) {
  return {
    configured: configured,
    appName: APP_CONFIG.appName,
    spreadsheetId: db.spreadsheet.getId(),
    spreadsheetUrl: db.spreadsheet.getUrl(),
    folderId: db.folder.getId(),
    folderUrl: db.folder.getUrl(),
    sheetName: APP_CONFIG.sheetName,
    rowCount: Math.max(0, db.sheet.getLastRow() - 1),
    maxCompressedImageBytes: APP_CONFIG.maxCompressedImageBytes,
    webAppUrl: getWebAppUrl_()
  };
}
