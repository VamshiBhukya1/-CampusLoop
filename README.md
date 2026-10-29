# CampusLoop

CampusLoop is a React/Vite frontend with an Express API backed by MySQL. Students browse campus resources, request books and equipment, reserve rooms, join waitlists, view notifications, download permitted PDFs, share moderated study materials, save resources, and report incidents. Administrators manage resources and physical assets, approve requests, issue and receive loans, manage documents and maintenance, and review users and audit history.

## Prerequisites

- Node.js 20 or later and npm
- MySQL 8.0 or a compatible managed MySQL service
- A writable persistent directory for PDFs (local `server/storage` in development)

MongoDB is no longer used by the application. Existing MongoDB data is not deleted or automatically imported; keep the old database and a verified backup until you have completed and checked your data conversion.

## Local MySQL setup

Create a database and a restricted application user using a MySQL administrator account. Substitute a strong password and do not grant the app user global privileges:

```sql
CREATE DATABASE campusloop CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'campusloop_app'@'localhost' IDENTIFIED BY 'choose-a-strong-local-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES ON campusloop.* TO 'campusloop_app'@'localhost';
```

Copy the environment template and edit `server/.env`:

```powershell
Copy-Item .env.example server/.env
```

Set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. Set `JWT_ACCESS_SECRET` to a unique random value with at least 32 characters. `DB_SSL=true` enables certificate-verified TLS when your MySQL host supports it. Set `FILE_STORAGE_DIR` to a persistent directory if you want PDFs to survive a local server restart or deploy.

Initialize tables, create the bootstrap admin if it does not already exist, and insert the fictional sample catalog:

```powershell
npm.cmd install
npm.cmd --prefix server install
npm.cmd --prefix client install
npm.cmd run db:init
npm.cmd run seed
npm.cmd run dev
```

The API listens on `http://localhost:4000`; Vite serves `http://localhost:5173` and proxies `/api` to it. Register a student from `/register`, or sign in with the admin email/password configured in `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. The seed never prints the password and does not reset the password for an existing admin row. Public registration always creates a student.

### Environment variables

The root `.env.example` is a server template. Copy it to `server/.env`; it is ignored by Git. Vite reads `client/.env` for frontend variables. For local development leave `VITE_API_URL` unset to use the `/api` proxy.

| Variable | Use |
|---|---|
| `NODE_ENV`, `PORT` | API environment and listening port |
| `CLIENT_URL`, `CORS_ORIGINS` | Public frontend URL for links, CORS, and CSRF origin checks; comma separate trusted origins |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL pool connection |
| `DB_POOL_SIZE` | Maximum pooled connections, default 10 |
| `DB_SSL` | Enable TLS with certificate verification when `true` |
| `JWT_ACCESS_SECRET` | JWT signing secret; never use a `VITE_` name |
| `FILE_STORAGE_DIR` | Persistent PDF storage directory |
| `MAX_PDF_SIZE_MB` | Admin PDF upload limit |
| `MAX_STUDY_FILE_SIZE_MB` | Student study-resource upload limit (default 25 MB) |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | One-time admin account creation by `npm run seed` |
| `BOOKING_ADVANCE_DAYS`, `MAX_BOOKING_HOURS`, `LOAN_DURATION_DAYS`, `WAITLIST_OFFER_HOURS`, `DUE_REMINDER_HOURS`, `REMINDER_INTERVAL_MINUTES` | Booking and reminder defaults |
| `VITE_API_URL` | Frontend only; full public API base URL including `/api` |

No refresh token, email, or SMS provider is configured. Login uses an eight-hour HttpOnly cookie. In production, the cookie uses `SameSite=None; Secure` so the Vercel frontend can call a separately hosted API; the server checks the request origin for cookie-authenticated changes.

### Adding study resources

No external catalog or third-party files are seeded. Sign in as a student and use **Study Resources → Upload a resource** to submit original or openly licensed PDF, DOCX, PPTX, or ZIP material. An administrator reviews submissions under **Study Resources → Moderation** before students can browse them. Downloads use the actual uploaded file stored in `FILE_STORAGE_DIR`; production storage must be persistent and included in backups.
## MySQL schema and migration

`npm run db:init` creates the relational tables idempotently. It does not drop or truncate data. The schema covers users, resources, assets, bookings, notifications, audit logs, documents, incidents, waitlist entries, maintenance records, and system settings, study resources, and student bookmarks. Study-resource uploads are held for admin moderation and support PDF, DOCX, PPTX, and ZIP files; stored names are generated server-side. IDs are UUIDs; foreign keys, unique email/asset/QR constraints, and indexes support the current workflows. Mutating API requests run within MySQL transactions. The connection pool is capped and reused by the Node process.

`npm run seed` can be run repeatedly. It creates the admin only when the email is absent and creates the sample catalog only when each sample key is absent.

### Existing MongoDB data

No MongoDB package or MongoDB connection remains in application code. The old database is not changed by the MySQL setup. Before retiring it:

1. Keep the old `MONGODB_URI` in a secure backup of your existing ignored `server/.env`; do not put it in the new example file or commit it.
2. Take and verify a MongoDB backup with `mongodump --uri "$env:MONGODB_URI" --archive=campusloop-mongo.archive.gz --gzip` and export GridFS files separately. Retain these backups until reconciliation is complete.
3. Export each collection to a protected working directory; repeat this command for `users`, `resources`, `assets`, `bookings`, `notifications`, `auditlogs`, `documents`, `incidents`, `waitinglistentries`, `maintenancerecords`, and `systemsettings`:

   ```powershell
   New-Item -ItemType Directory -Force mongo-export | Out-Null
   mongoexport --uri "$env:MONGODB_URI" --collection users --jsonArray --out mongo-export/users.json
   ```

   Use `mongofiles --uri "$env:MONGODB_URI" --prefix campusloop_documents list` to inventory GridFS files and export each stored PDF with the corresponding `mongofiles get` command. Keep the export directory private and delete it securely after migration verification.
4. Convert and import the exported collections into the MySQL schema, preserving relationships among Mongo ObjectIds (users, resources, assets, bookings, documents, and related records). Map each old ObjectId to one UUID and rewrite every foreign key consistently. Copy GridFS PDF bytes into `FILE_STORAGE_DIR` and update each document's `fileKey`.
5. Compare row counts, account email/roles, active loans and asset states, waitlists, document versions, and PDF hashes before switching traffic.

There is no automatic Mongo-to-MySQL importer in this repository. Do not point a migration tool at production or discard the MongoDB source until a project-specific conversion has been rehearsed on backups and the imported data has been checked. Local student accounts do not automatically transfer to production.

## Tests and builds

```powershell
npm.cmd test
npm.cmd --prefix client run build
```

The fast API tests do not require MySQL. The integration suite needs a dedicated database whose name contains `test`; it never clears the database. Configure `DB_TEST_HOST`, `DB_TEST_PORT`, `DB_TEST_USER`, `DB_TEST_PASSWORD`, and `DB_TEST_NAME` before running `npm.cmd test`. Use a separate database and user with privileges only on that test schema. Tests cover registration/login, role checks, resources/assets, loans and returns, room conflicts, waitlists, maintenance, PDF access, audit events, and reminders.

## Deployment

### Managed MySQL

Create a managed MySQL 8 database, a least-privilege app user, and restrict inbound connections to the backend host where possible. Enable TLS and set the provider's CA settings as needed. Create the database before deploying, provide `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`, and a strong `JWT_ACCESS_SECRET` through the backend host's secret manager, then run `npm run db:init` as a deployment/release command. Run `npm run seed` once if you need the bootstrap admin and sample resources. Do not expose database or JWT settings to Vercel's `VITE_` environment.

### Express backend

Deploy `server/` as a long-running Node.js service on a host that supports Node 20, outbound TLS database connections, scheduled process work, and a persistent mounted disk for PDFs and study-resource files. Set the start command to `npm start`; set `FILE_STORAGE_DIR` to the persistent mount path. Student files use the same storage root, so that volume must persist and be backed up. Set `MAX_STUDY_FILE_SIZE_MB` to your upload policy. The API is a separate deployment from the static Vercel frontend. Configure `CLIENT_URL` and `CORS_ORIGINS` to the exact production frontend origin(s), such as the Vercel custom domain. Add preview origins only if those previews should be trusted to authenticate.

### Vercel frontend

1. Import the repository into Vercel and set the project root to `client`.
2. Use the Vite build command `npm run build` and output directory `dist`.
3. Add `VITE_API_URL=https://your-api-host.example/api` in the Vercel project environment settings for Production (and Preview only if the API trusts that preview origin).
4. Deploy and verify direct refreshes on `/login`, `/register`, and the dashboard. `client/vercel.json` rewrites client routes to `index.html`.
5. Add the final Vercel origin to the backend `CLIENT_URL`/`CORS_ORIGINS`, then redeploy the backend. Confirm credentialed CORS and secure cookies through a browser login.

## Troubleshooting

- **`Missing required environment variable: DB_HOST`**: copy `.env.example` to `server/.env` and fill in the MySQL variables.
- **Connection refused / access denied**: confirm MySQL is running, database exists, host and port are reachable from the API host, and app-user permissions are scoped to the database.
- **Unknown database**: create the schema before `npm run db:init`.
- **Login succeeds but session is lost on Vercel**: use HTTPS, verify `SameSite=None; Secure`, `withCredentials`, and an exact trusted origin in `CORS_ORIGINS`.
- **PDF or study material missing after deployment/restart**: set `FILE_STORAGE_DIR` to a mounted persistent disk and ensure the process can read/write it. Do not use an ephemeral filesystem for production documents.
- **Admin cannot sign in**: check the configured bootstrap email; rerunning the seed does not reset an existing account's password.

There is no email/SMS delivery, physical scanner integration, fines system, or built-in Mongo data importer. Production still needs monitoring, backups for MySQL and the PDF volume, account recovery, and operational review of retention policies.
