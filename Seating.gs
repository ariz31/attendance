/**
 * Seating Arrangement Maker backend.
 *
 * Adds two sheets to the same Apps Script database:
 * - Seating Arrangements: one row per occupied seat, plus a metadata row for empty layouts.
 * - Seating Absences: one row per absent click/log entry.
 */

const SEATING_CONFIG = {
  arrangementSheetName: 'Seating Arrangements',
  absenceSheetName: 'Seating Absences',
  maxRows: 20,
  maxColumns: 20,
  maxSeats: 250,
  maxSeatImageBytes: 2 * 1024 * 1024,
  arrangementHeaders: [
    'Arrangement ID',
    'Updated Timestamp',
    'Title',
    'Rows',
    'Columns',
    'Seat ID',
    'Seat Row',
    'Seat Column',
    'Nickname',
    'Student Name',
    'Image File ID',
    'Image URL',
    'Image MIME Type',
    'Original Size Bytes',
    'Compressed Size Bytes',
    'Source Filename',
    'Device ID',
    'Status'
  ],
  absenceHeaders: [
    'Absence ID',
    'Server Timestamp',
    'Client Timestamp',
    'Arrangement ID',
    'Arrangement Title',
    'Seat ID',
    'Seat Row',
    'Seat Column',
    'Nickname',
    'Student Name',
    'Device ID',
    'Status',
    'Notes'
  ]
};

function saveSeatingArrangement(arrangement) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const db = ensureSeatingDatabase_();
    const normalized = normalizeSeatingArrangement_(arrangement);
    deleteExistingArrangementRows_(db.arrangementSheet, normalized.id);

    const rows = [];
    let imageUploads = 0;

    normalized.seats.forEach(function(seat) {
      let imageFileId = seat.imageFileId;
      let imageUrl = seat.imageUrl;
      let imageMimeType = seat.mimeType;

      if (seat.imageBase64) {
        const imageBlob = buildSeatImageBlob_(normalized, seat);
        const imageFile = db.folder.createFile(imageBlob);
        imageFile.setDescription('Seating photo for ' + (seat.nickname || seat.studentName || seat.seatId) + ' in ' + normalized.title);
        imageFileId = imageFile.getId();
        imageUrl = imageFile.getUrl();
        imageMimeType = imageBlob.getContentType();
        imageUploads += 1;
      }

      rows.push([
        normalized.id,
        new Date(),
        normalized.title,
        normalized.rows,
        normalized.columns,
        seat.seatId,
        seat.row,
        seat.column,
        seat.nickname,
        seat.studentName,
        imageFileId || '',
        imageUrl || '',
        imageMimeType || '',
        seat.originalSize || 0,
        seat.compressedSize || 0,
        seat.sourceFileName || '',
        normalized.deviceId,
        'active'
      ]);
    });

    if (rows.length === 0) {
      rows.push([
        normalized.id,
        new Date(),
        normalized.title,
        normalized.rows,
        normalized.columns,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        0,
        0,
        '',
        normalized.deviceId,
        'layout-only'
      ]);
    }

    db.arrangementSheet
      .getRange(db.arrangementSheet.getLastRow() + 1, 1, rows.length, SEATING_CONFIG.arrangementHeaders.length)
      .setValues(rows);

    return {
      ok: true,
      arrangementId: normalized.id,
      savedSeats: normalized.seats.length,
      imageUploads: imageUploads,
      message: 'Seating arrangement saved.'
    };
  } finally {
    lock.releaseLock();
  }
}

function listSeatingArrangements(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const db = ensureSeatingDatabase_();
  const lastRow = db.arrangementSheet.getLastRow();

  if (lastRow <= 1) {
    return [];
  }

  const values = db.arrangementSheet
    .getRange(2, 1, lastRow - 1, SEATING_CONFIG.arrangementHeaders.length)
    .getValues();

  const grouped = {};

  values.forEach(function(row) {
    const arrangementId = row[0];
    if (!arrangementId) return;

    if (!grouped[arrangementId]) {
      grouped[arrangementId] = {
        id: String(arrangementId),
        title: row[2] || 'Untitled seating plan',
        rows: Number(row[3]) || 0,
        columns: Number(row[4]) || 0,
        seatCount: 0,
        updatedAt: row[1]
      };
    }

    if (row[5]) {
      grouped[arrangementId].seatCount += 1;
    }

    const currentTime = grouped[arrangementId].updatedAt instanceof Date
      ? grouped[arrangementId].updatedAt.getTime()
      : 0;
    const rowTime = row[1] instanceof Date ? row[1].getTime() : 0;

    if (rowTime > currentTime) {
      grouped[arrangementId].updatedAt = row[1];
      grouped[arrangementId].title = row[2] || grouped[arrangementId].title;
      grouped[arrangementId].rows = Number(row[3]) || grouped[arrangementId].rows;
      grouped[arrangementId].columns = Number(row[4]) || grouped[arrangementId].columns;
    }
  });

  return Object.keys(grouped)
    .map(function(id) {
      const item = grouped[id];
      item.updatedAt = formatDateForClient_(item.updatedAt);
      return item;
    })
    .sort(function(a, b) {
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    })
    .slice(0, safeLimit);
}

function getSeatingArrangement(arrangementId) {
  const requestedId = requiredString_(arrangementId, 'Arrangement ID', 120);
  const db = ensureSeatingDatabase_();
  const lastRow = db.arrangementSheet.getLastRow();

  if (lastRow <= 1) {
    throw new Error('No seating arrangements have been saved yet.');
  }

  const values = db.arrangementSheet
    .getRange(2, 1, lastRow - 1, SEATING_CONFIG.arrangementHeaders.length)
    .getValues();

  const matchingRows = values.filter(function(row) {
    return String(row[0]) === requestedId;
  });

  if (matchingRows.length === 0) {
    throw new Error('Seating arrangement was not found.');
  }

  let latestMeta = matchingRows[0];
  matchingRows.forEach(function(row) {
    const latestTime = latestMeta[1] instanceof Date ? latestMeta[1].getTime() : 0;
    const rowTime = row[1] instanceof Date ? row[1].getTime() : 0;
    if (rowTime > latestTime) {
      latestMeta = row;
    }
  });

  const seats = matchingRows
    .filter(function(row) { return row[5]; })
    .map(function(row) {
      return {
        seatId: String(row[5]),
        row: Number(row[6]) || 0,
        column: Number(row[7]) || 0,
        nickname: row[8] || '',
        studentName: row[9] || '',
        imageFileId: row[10] || '',
        imageUrl: row[11] || '',
        mimeType: row[12] || '',
        originalSize: Number(row[13]) || 0,
        compressedSize: Number(row[14]) || 0,
        sourceFileName: row[15] || ''
      };
    });

  return {
    id: requestedId,
    title: latestMeta[2] || 'Untitled seating plan',
    rows: Number(latestMeta[3]) || 1,
    columns: Number(latestMeta[4]) || 1,
    updatedAt: formatDateForClient_(latestMeta[1]),
    seats: seats
  };
}

function recordSeatingAbsences(absences) {
  if (!Array.isArray(absences)) {
    throw new Error('Expected an array of absence records.');
  }

  if (absences.length === 0) {
    return { ok: true, saved: 0, results: [] };
  }

  if (absences.length > 50) {
    throw new Error('Batch is too large. Send at most 50 absence records at a time.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const db = ensureSeatingDatabase_();
    const existingIds = getExistingAbsenceIds_(db.absenceSheet);
    const rows = [];
    const results = [];

    absences.forEach(function(absence, index) {
      const fallbackId = absence && absence.id ? String(absence.id) : 'absence-' + index;

      try {
        const normalized = normalizeSeatingAbsence_(absence);

        if (existingIds[normalized.id]) {
          results.push({ id: normalized.id, status: 'duplicate' });
          return;
        }

        rows.push([
          normalized.id,
          new Date(),
          parseDateOrBlank_(normalized.clientTimestamp),
          normalized.arrangementId,
          normalized.arrangementTitle,
          normalized.seatId,
          normalized.row,
          normalized.column,
          normalized.nickname,
          normalized.studentName,
          normalized.deviceId,
          'absent',
          normalized.notes
        ]);

        existingIds[normalized.id] = true;
        results.push({ id: normalized.id, status: 'synced' });
      } catch (error) {
        results.push({ id: fallbackId, status: 'error', message: error.message });
      }
    });

    if (rows.length > 0) {
      db.absenceSheet
        .getRange(db.absenceSheet.getLastRow() + 1, 1, rows.length, SEATING_CONFIG.absenceHeaders.length)
        .setValues(rows);
    }

    return { ok: true, saved: rows.length, results: results };
  } finally {
    lock.releaseLock();
  }
}

function listRecentSeatingAbsences(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const db = ensureSeatingDatabase_();
  const lastRow = db.absenceSheet.getLastRow();

  if (lastRow <= 1) {
    return [];
  }

  const rowCount = Math.min(safeLimit, lastRow - 1);
  const startRow = lastRow - rowCount + 1;
  const values = db.absenceSheet
    .getRange(startRow, 1, rowCount, SEATING_CONFIG.absenceHeaders.length)
    .getValues();

  return values.reverse().map(function(row) {
    return {
      id: row[0],
      serverTimestamp: formatDateForClient_(row[1]),
      clientTimestamp: formatDateForClient_(row[2]),
      arrangementId: row[3],
      arrangementTitle: row[4],
      seatId: row[5],
      row: row[6],
      column: row[7],
      nickname: row[8],
      studentName: row[9],
      deviceId: row[10],
      status: row[11],
      notes: row[12]
    };
  });
}

function ensureSeatingDatabase_() {
  const spreadsheet = getOrCreateSpreadsheet_();
  const folder = getOrCreateImageFolder_();
  const arrangementSheet = getOrCreateSheet_(spreadsheet, SEATING_CONFIG.arrangementSheetName, SEATING_CONFIG.arrangementHeaders);
  const absenceSheet = getOrCreateSheet_(spreadsheet, SEATING_CONFIG.absenceSheetName, SEATING_CONFIG.absenceHeaders);
  return { spreadsheet, folder, arrangementSheet, absenceSheet };
}

function normalizeSeatingArrangement_(arrangement) {
  if (!arrangement || typeof arrangement !== 'object') {
    throw new Error('Invalid seating arrangement payload.');
  }

  const rows = clampInteger_(arrangement.rows, 1, SEATING_CONFIG.maxRows, 'Rows');
  const columns = clampInteger_(arrangement.columns, 1, SEATING_CONFIG.maxColumns, 'Columns');
  const seats = Array.isArray(arrangement.seats) ? arrangement.seats : [];

  if (rows * columns > SEATING_CONFIG.maxSeats) {
    throw new Error('Seating layout is too large. Maximum is ' + SEATING_CONFIG.maxSeats + ' seats.');
  }

  const normalizedSeats = seats
    .map(function(seat) {
      return normalizeSeat_(seat, rows, columns);
    })
    .filter(function(seat) {
      return seat.nickname || seat.studentName || seat.imageBase64 || seat.imageUrl || seat.imageFileId;
    });

  return {
    id: requiredString_(arrangement.id, 'Arrangement ID', 120),
    title: requiredString_(arrangement.title, 'Seating title', 200),
    rows: rows,
    columns: columns,
    deviceId: optionalString_(arrangement.deviceId, '', 120),
    seats: normalizedSeats
  };
}

function normalizeSeat_(seat, maxRows, maxColumns) {
  if (!seat || typeof seat !== 'object') {
    throw new Error('Invalid seat payload.');
  }

  const row = clampInteger_(seat.row, 1, maxRows, 'Seat row');
  const column = clampInteger_(seat.column, 1, maxColumns, 'Seat column');
  const imageBase64 = optionalString_(seat.imageBase64, '', SEATING_CONFIG.maxSeatImageBytes * 2);
  const compressedSize = safeNumber_(seat.compressedSize);

  if (compressedSize > SEATING_CONFIG.maxSeatImageBytes) {
    throw new Error('Seat image is too large. Maximum is ' + SEATING_CONFIG.maxSeatImageBytes + ' bytes.');
  }

  return {
    seatId: optionalString_(seat.seatId, 'R' + row + 'C' + column, 80),
    row: row,
    column: column,
    nickname: optionalString_(seat.nickname, '', 120),
    studentName: optionalString_(seat.studentName, '', 200),
    imageBase64: imageBase64,
    imageFileId: optionalString_(seat.imageFileId, '', 120),
    imageUrl: optionalString_(seat.imageUrl, '', 500),
    mimeType: optionalString_(seat.mimeType, 'image/jpeg', 80),
    originalSize: safeNumber_(seat.originalSize),
    compressedSize: compressedSize,
    sourceFileName: optionalString_(seat.sourceFileName, '', 180)
  };
}

function normalizeSeatingAbsence_(absence) {
  if (!absence || typeof absence !== 'object') {
    throw new Error('Invalid absence payload.');
  }

  return {
    id: requiredString_(absence.id, 'Absence ID', 120),
    arrangementId: requiredString_(absence.arrangementId, 'Arrangement ID', 120),
    arrangementTitle: optionalString_(absence.arrangementTitle, '', 200),
    seatId: requiredString_(absence.seatId, 'Seat ID', 80),
    row: clampInteger_(absence.row, 1, SEATING_CONFIG.maxRows, 'Seat row'),
    column: clampInteger_(absence.column, 1, SEATING_CONFIG.maxColumns, 'Seat column'),
    nickname: optionalString_(absence.nickname, '', 120),
    studentName: optionalString_(absence.studentName, '', 200),
    deviceId: optionalString_(absence.deviceId, '', 120),
    clientTimestamp: optionalString_(absence.clientTimestamp, '', 80),
    notes: optionalString_(absence.notes, '', 500)
  };
}

function buildSeatImageBlob_(arrangement, seat) {
  const parsed = parseBase64Image_(seat.imageBase64, seat.mimeType || 'image/jpeg');

  if (parsed.bytes.length > SEATING_CONFIG.maxSeatImageBytes) {
    throw new Error('Decoded seat image is too large. Reduce image quality or dimensions.');
  }

  const extension = mimeTypeToExtension_(parsed.mimeType);
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const parts = [
    timestamp,
    sanitizeFilenamePart_(arrangement.title),
    sanitizeFilenamePart_(seat.seatId),
    sanitizeFilenamePart_(seat.nickname || seat.studentName || 'student')
  ];

  return Utilities.newBlob(parsed.bytes, parsed.mimeType, parts.filter(Boolean).join('_') + '.' + extension);
}

function deleteExistingArrangementRows_(sheet, arrangementId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  for (let index = values.length - 1; index >= 0; index--) {
    if (String(values[index][0]) === String(arrangementId)) {
      sheet.deleteRow(index + 2);
    }
  }
}

function getExistingAbsenceIds_(sheet) {
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

function clampInteger_(value, min, max, label) {
  const number = Math.floor(Number(value));

  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
  }

  return number;
}
