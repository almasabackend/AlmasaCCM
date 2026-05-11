# WhatsApp Contact Guard Web

Hostinger-ready Node.js web app for managing WhatsApp promotional contact lists with country-specific suppression lists.

This web version supports:

- UAE and Saudi Arabia management tabs.
- Company name, person name, WhatsApp number, and email fields.
- Optional fields: if a file has name/company/email, they are saved; if not, the contact still imports.
- CSV/XLSX import with all Excel sheets read.
- Automatic phone detection and normalization.
- UAE examples: `0552605247`, `552605247`, `971552605247`, `00971552605247`.
- Saudi examples: `0551234567`, `551234567`, `966551234567`, `00966551234567`.
- Automatic detection of subscribed/unsubscribed text in uploaded rows.
- Suppression logic: unsubscribed or blocked contacts are never exported.
- Campaign export capped at 1,000 subscribed contacts.
- Phone-only export for WhatsApp upload and full contact export for team use.
- Excel-safe CSV format using `="+971..."` or `="+966..."`.

## Status Detection During Import

The importer checks status-like columns first:

```text
status, subscription, subscribe, unsubscribe, opt in, opt out,
consent, permission, remarks, notes, comments, action
```

It also scans the rest of the row. Unsubscribe words win over subscribe words.

Examples detected as unsubscribed:

```text
unsubscribe, unsubscribed, opt out, stop, remove, do not contact,
suppressed, blacklisted, blocked
```

Examples detected as subscribed:

```text
subscribe, subscribed, opt in, active, allowed, consent, yes
```

If a row says subscribed but the number was already unsubscribed before, the app keeps it suppressed. Re-subscribing must be done manually from the Contacts screen after clear opt-in.

## Local Setup

```bash
cd "/Users/udarakaruchiran/Documents/New Project/whatsapp-contact-guard-web"
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3000
```

If database credentials are empty, the app runs in temporary memory mode for local demo only.

## Hostinger Setup

1. Create a MySQL/MariaDB database in Hostinger hPanel.
2. Add the database credentials as environment variables:

```text
DB_HOST=your-hostinger-db-host
DB_PORT=3306
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-db-name
ADMIN_PASSWORD=your-secure-admin-password
SESSION_SECRET=a-long-random-secret
NODE_ENV=production
```

3. Deploy the project using Hostinger Node.js Web App.
4. Start command:

```bash
npm start
```

The app creates the required SQL tables automatically on startup.

## Deployment Diagnostics

If Hostinger shows `503 Service Unavailable`, open:

```text
https://your-domain/diagnostics
```

or:

```text
https://your-domain/healthz
```

The diagnostics page shows the exact MySQL connection error code/message without exposing the database password.

## Deploy Options

Hostinger gives two choices:

- **Connect with GitHub**: best for updates and future maintenance.
- **Upload your files**: simpler for first deployment.

## Tests

```bash
npm test
```
