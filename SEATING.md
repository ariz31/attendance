# Seating Arrangement Maker

This module adds a seating arrangement workflow to the Apps Script attendance app.

## User flow

1. Enter a seating title, row count, and column count.
2. Click **Create / Resize Grid**.
3. Click a location in the grid to edit the assigned student.
4. Add the student's nickname, full name/notes, and optional picture.
5. Click **Save Seat**.
6. Click **Save Seating Arrangement** to sync the plan to Google Sheets and Drive.
7. Turn on **Absent Mode**.
8. Click a student location to mark that student absent.
9. Absence clicks are saved locally first and synced to the `Seating Absences` sheet when online.

## Data storage

The module creates two additional sheets in the same spreadsheet used by the attendance app.

### Seating Arrangements

One row is written per occupied seat. Empty layouts are saved with a metadata-only row.

Columns:

- Arrangement ID
- Updated Timestamp
- Title
- Rows
- Columns
- Seat ID
- Seat Row
- Seat Column
- Nickname
- Student Name
- Image File ID
- Image URL
- Image MIME Type
- Original Size Bytes
- Compressed Size Bytes
- Source Filename
- Device ID
- Status

### Seating Absences

One row is written per absent click.

Columns:

- Absence ID
- Server Timestamp
- Client Timestamp
- Arrangement ID
- Arrangement Title
- Seat ID
- Seat Row
- Seat Column
- Nickname
- Student Name
- Device ID
- Status
- Notes

## Image behavior

Student seat photos are compressed in the browser before sync. The backend saves the compressed photos to the same Google Drive image folder used by the attendance capture flow.

Default seat photo compression:

- Max dimension: 360px
- JPEG quality: 68%
- Backend max compressed size: 2 MB per seat photo

## Offline behavior

The seating draft and absence queue are stored locally on the browser using `localStorage`.

- Seat edits remain available locally on the same device/browser.
- Absence clicks are queued locally when offline.
- Absence clicks sync to Apps Script once the device is online.

For many students with photos, sync the arrangement regularly because browser local storage has smaller capacity than IndexedDB.
