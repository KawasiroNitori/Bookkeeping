# Google Apps Script backend

This folder contains the web-app script that must be deployed with the
Bookkeeping frontend.

Setup:

1. Open the v2 ledger Google Sheet:
   `https://docs.google.com/spreadsheets/d/1OIVAlCIiRUWUTLctATHCVEXXYcyMM7sHriQL8pCv3dg/edit`
2. Go to Extensions > Apps Script.
3. Replace the script with `apps-script/Code.gs`.
4. Deploy it as a web app.
5. Use "Execute as: me" and allow access for anyone who has the web app URL.
6. If the deployment URL changes, update `SCRIPT_URL` in `app.js`.

The frontend now sends targeted mutations:

- `appendTransaction` for new ledger rows.
- `updateTransaction` for editing one row.
- `deleteTransaction` for deleting one row.
- `addMember`, `updateMember`, and `deleteMember` for member rows.
- `saveAll` only for explicit cache restore.

Normal input should no longer rewrite the whole workbook.

The active schema is `flat-member-columns-v1`: delivery participants are stored in
`transactions.participantsJson`, and each current member has a `member:<id>:<name>`
delta column in `transactions`.
