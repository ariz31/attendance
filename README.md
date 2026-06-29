# Attendance Capture

Offline-capable attendance capture app built with **Google Apps Script HTML Service**, **Google Sheets**, **Google Drive**, browser-side **image compression**, and an **IndexedDB local sync queue**.

This repository implements **Option B**: keep the app inside Apps Script while still allowing users to create records offline after the app has loaded.

## What the app does

- Captures these fields:
  - Name
  - Class Code
  - Title
  - Image
- Compresses the image in the browser before saving or uploading.
- Saves records first to the local device using IndexedDB.
- Syncs records to Apps Script when internet is available.
- Stores image files in Google Drive.
- Stores metadata rows in Google Sheets.
- Prevents duplicate syncs using client-generated record IDs.
- Shows pending, synced, duplicate, and error states in the app.

## Important limitation of the Apps Script-only approach

This is an **offline-capable Apps Script web app**, not a perfect standalone PWA.

Apps Script HTML Service is served inside Google's Apps Script runtime. Because of that, this version can queue and preserve records offline **after the page has already loaded**, but it should not be treated like a fully installable static PWA with a normal service worker cache.

For a production-grade installable PWA, the recommended architecture is:

```text
Frontend PWA: Firebase Hosting / GitHub Pages / Netlify
Backend API: Google Apps Script Web App
Database: Google Sheets
Image Storage: Google Drive
```

This repository intentionally uses the Apps Script-only version requested.

## Files

```text
appsscript.json   Apps Script manifest and scopes
Code.gs           Apps Script backend, setup, Sheets/Drive sync
Index.html        HTML shell
Styles.html       CSS styles
Client.html       Browser logic, compression, IndexedDB queue, sync
.claspignore      Files to push with clasp
.gitignore        Local development ignores
```

## Google Sheet schema

The app creates or links a spreadsheet with an `Attendance` sheet containing these columns:

| Column | Description |
| --- | --- |
| Record ID | Client-generated UUID for idempotent sync |
| Server Timestamp | Date/time written by Apps Script |
| Client Timestamp | Date/time captured on the device |
| Name | Captured person name |
| Class Code | Class or section code |
| Title | Attendance event/title |
| Image File ID | Google Drive file ID |
| Image URL | Google Drive file URL |
| Image MIME Type | Usually `image/jpeg` |
| Original Size Bytes | Size before browser compression |
| Compressed Size Bytes | Size after browser compression |
| Compression Ratio | Compressed/original size ratio |
| Source Filename | Original filename from the device |
| Device ID | Locally generated device identifier |
| Status | Server-side saved status |
| Notes | Reserved for future use |

## Deployment with clasp

Install clasp if needed:

```bash
npm install -g @google/clasp
```

Log in:

```bash
clasp login
```

Create a new standalone Apps Script project:

```bash
clasp create --type standalone --title "Attendance Capture"
```

This creates a local `.clasp.json` file. Keep that file local because it contains the Apps Script project ID.

Push the code:

```bash
clasp push
```

Open the Apps Script project:

```bash
clasp open
```

## First-time setup

1. In Apps Script, run the `setup` function once from the editor.
2. Approve the requested Google Sheets and Drive permissions.
3. Deploy the script as a web app:
   - Click **Deploy**.
   - Choose **New deployment**.
   - Select **Web app**.
   - Execute as: usually **Me** for classroom/owned deployment.
   - Who has access: choose the audience you need.
4. Open the web app URL.
5. Click **Initialize Database** if the setup panel still says the database is not initialized.

## Usage

1. Open the deployed web app while online at least once.
2. Enter the name, class code, title, and image.
3. Choose image compression settings.
4. Click **Save to Offline Queue**.
5. If online, the app syncs immediately.
6. If offline, the record remains on the device and syncs when the connection returns.

## Image handling

Images are compressed in the browser using a canvas before they are queued or uploaded.

Defaults:

- Max dimension: `1280px`
- JPEG quality: `70%`
- Max compressed upload size: `5 MB`

Only compressed images are sent to Apps Script.

## Notes for future improvements

- Add authentication or class-code allowlists.
- Add admin dashboard and filters.
- Add manual CSV export.
- Add QR code mode for prefilled class code/title.
- Add separate `Classes` and `Events` sheets.
- Move the frontend to Firebase Hosting if a true installable PWA/service worker is required.
