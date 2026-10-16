# PPEC Operating Room Booking Platform

A responsive web application for Phnom Penh Eye Clinic (PPEC) to manage operating-room availability, surgeon bookings, surgeon profiles, commission calculations, grouped/partial payments, operational reporting, and audit history.

> **Deployment status:** this repository contains the application source and local setup tooling. It is not connected to PPEC's production database, patient system, domain, hosting, or credentials. Configure and test it in a non-production environment before entering real patient or financial data. The built-in demo is fictional and does not save data.

## Features

- Administrator, internal doctor, and external doctor roles.
- Administrator-created accounts only; phone-number login; forced password change for temporary credentials.
- Shared calendar for Bed A — Zeiss and Bed B — Leica. Doctors see generic booked blocks for other doctors, without names or patient details.
- Day/week/month calendar views; create, view, edit notes, cancel, and reschedule bookings.
- Configurable surgery type and 30-minute-increment duration (30–360 minutes).
- Monday–Saturday default sessions: 08:00–11:00 and 14:00–17:00, using `Asia/Phnom_Penh` local time.
- 48-hour advance booking and 24-hour cancellation rules; administrator overrides require a reason.
- PostgreSQL exclusion constraint prevents overlapping bookings on the same bed, including concurrent requests. The two beds can be booked at the same time.
- Minimal patient reference fields and optional HTTPS link to an existing PPEC record. No external patient system is scraped or called.
- Completed-surgery fee/commission ledger using the commission rate snapshot from the actual surgery.
- Multiple payment allocations, partial payments, payment reversals, manual financial adjustments, and audit trails.
- Dashboards, operational/financial reports, filters, and CSV exports.
- Secure server-side sessions, role/ownership checks, password hashing, login rate limiting, session expiry, input limits, Helmet security headers, and CSRF/cross-origin state-change protection.
- Fictional demo preview to inspect the interface without setting up the database.

## Architecture

```text
Browser (HTML + CSS + vanilla JavaScript)
                 |
          Same-origin HTTPS
                 |
      Node.js + Express REST API
      - session authentication
      - role / ownership checks
      - booking business rules
      - payment allocation logic
      - audit log writes
                 |
             PostgreSQL
      - normalized relational schema
      - foreign keys and checks
      - exclusion constraint for room overlap
      - persistent session store
```

The app is deployed as a single web service to keep configuration simple. PostgreSQL can run locally using Docker Compose or as a managed database. Frontend assets are served by Express; there is no separate frontend build step.

## Requirements

- Node.js 20 or later (Node 22 recommended).
- PostgreSQL 14 or later. The local Docker Compose file uses PostgreSQL 16.
- npm.
- Production deployment must provide HTTPS and persistent PostgreSQL storage/backups.

## Local setup

1. Extract the project and open a terminal in its folder.
2. Start PostgreSQL (Docker is optional):

   ```bash
   docker compose up -d postgres
   ```

3. Copy `.env.example` to `.env`. Set at least:

   ```env
   NODE_ENV=development
   PORT=3000
   SESSION_SECRET=replace-with-a-long-random-secret-of-at-least-32-characters
   DATABASE_URL=postgresql://ppec_user:ppec_dev_local_password@localhost:5432/ppec_or_booking
   SSL_MODE=disable
   COOKIE_SECURE=false
   INITIAL_ADMIN_NAME=PPEC System Administrator
   INITIAL_ADMIN_PHONE=85512345678
   INITIAL_ADMIN_PASSWORD=use-a-unique-password-with-12-or-more-characters
   ```

   Generate a session secret, for example, with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`. Never commit `.env` or reuse example passwords.

4. Install dependencies and initialize the database:

   ```bash
   npm install
   npm run db:migrate
   npm run admin:create
   npm test
   npm start
   ```

5. Open `http://localhost:3000`. Sign in with the initial administrator phone/password from `.env`.

If Docker is not available, create a PostgreSQL database and user manually, then put the provider's connection string in `DATABASE_URL`.

### First administrator

`npm run admin:create` creates one active administrator from `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_PHONE`, and `INITIAL_ADMIN_PASSWORD`. It intentionally refuses to create another initial administrator if an admin already exists. Keep the real password private. After setup, remove or rotate the initial password variable in the host's environment configuration.

### Create doctor accounts

Sign in as administrator, open **User Management / Surgeon Profiles**, and create an internal or external doctor account. The API hashes temporary passwords and sets `password_change_required` so the doctor must choose a new password before viewing protected data. The administrator can reset a password; a generated temporary password is shown only at reset time. A one-character temporary password is technically accepted by the doctor-creation endpoint to match the specified legacy workflow but is strongly discouraged; use a unique random temporary value and require a change at first login.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection URI. Keep secrets server-side. |
| `SESSION_SECRET` | Production | At least 32 random characters; set a unique secret. |
| `NODE_ENV` | No | `production` enables secure-cookie/proxy assumptions and secret validation. |
| `PORT` | No | Web server port (default `3000`). |
| `COOKIE_SECURE` | No | Set `true` only behind HTTPS; production defaults to secure cookies. |
| `SSL_MODE` | No | Use `require` for managed databases that require TLS. |
| `PGSSL_REJECT_UNAUTHORIZED` | No | Defaults to `true` to validate the database TLS certificate; only set `false` if the provider explicitly requires it and you understand the security trade-off. |
| `INITIAL_ADMIN_NAME` | Setup | First administrator name. |
| `INITIAL_ADMIN_PHONE` | Setup | First administrator login phone. |
| `INITIAL_ADMIN_PASSWORD` | Setup | Unique password of at least 12 characters with letters and digits. |

## Database and migration notes

The first migration is `db/migrations/001_initial_schema.sql`. It creates the core tables:

- `users`, `doctors`, `surgery_types`, `operating_rooms`, `operating_hours`, `blocked_periods`
- `patients`, `bookings`, `surgery_financials`, `payments`, `payment_allocations`, `audit_logs`

The database migration also enables PostgreSQL `pgcrypto` and `btree_gist` extensions. The booking table has a PostgreSQL exclusion constraint on room and time range; overlapping bookings on the same bed are rejected even if two requests arrive concurrently. Your database user must be permitted to enable those extensions (or a database administrator should enable them ahead of time). A `schema_migrations` table tracks applied migrations.

Default opening sessions are Monday–Saturday, 08:00–11:00 and 14:00–17:00. Default beds are Bed A — Zeiss and Bed B — Leica. Default surgery types are pterygium (30 min), cataract (60 min), eyelid (60 min), and “Other surgery” (30 or 60 min). Admins can configure working hours and surgery types in the UI.

## Booking and payment rules

- A booking must be made at least 48 hours before the start time unless an administrator explicitly enables an override and records a reason.
- A doctor can cancel at least 24 hours before the start. An administrator needs an override reason to cancel inside the cutoff.
- The entire operation must fit in one active operating session and must not intersect a blocked period, unless a recorded administrator override is used. Bed conflicts are never overridden.
- Bookings are retained as history with status changes instead of deleting historical records.
- Surgeon commission is `eligible surgery fee × commission percentage / 100`, rounded to two decimal places. Each completed surgery records a snapshot of the commission rate. Payments are never generated automatically from surgery completion.
- Grouped/partial payment allocations are stored individually. Reversing a payment leaves the original transaction for audit, while its allocations no longer count as paid.
- The initial UI displays money in USD. Before production, confirm PPEC's policy for currency, eligible charges, discounts/refunds, rounding and reporting.

## Privacy and security model

- Public self-registration is disabled.
- Login and application APIs require an active server-side session (except login and health check).
- The backend checks the user's active status each request and enforces roles and booking ownership in API handlers.
- Other doctors receive only generic calendar blocks for bookings they do not own.
- Doctor payment/profile endpoints are scoped to the authenticated doctor. Admin-only routes protect staff, room configuration, all-patient schedules, finance and audit history.
- Passwords are bcrypt-hashed; plaintext passwords are not stored. Session cookies are HTTP-only and expire after eight hours; login attempts are rate limited.
- `external_record_url` is treated only as a reference. There is no live patient-record-system integration in this codebase.

This implementation is a security-conscious starting point, not a substitute for a PPEC-specific security review. Before live patient data: use HTTPS, review database grants and hosting network rules, add a tested backup/restore schedule, validate local regulatory and consent requirements, use separate least-privilege service credentials, and run a penetration test. Avoid putting clinical details into notes.

## Deploying to a managed host

A typical low-maintenance deployment uses a managed PostgreSQL service plus one Node.js web service (for example, a platform such as Render/Fly.io/ Railway or an equivalent provider). These are examples, not endorsements; feature availability and pricing change, so check provider pricing before choosing.

1. Create a managed PostgreSQL database and note its private connection string, TLS requirements and backup/restore process.
2. Deploy the project repository as a Node.js web service; build command `npm install`, start command `npm start`.
3. Add `DATABASE_URL`, `SESSION_SECRET` (unique random value), `NODE_ENV=production`, `COOKIE_SECURE=true`, and `SSL_MODE=require` if required by your provider.
4. Run `npm run db:migrate` from the deployment shell/release process once before serving live traffic; create the first admin with `npm run admin:create` in a secure one-off shell.
5. Attach a clinic-controlled domain and enable HTTPS. Confirm the service terminates TLS correctly; do not enable production without it.
6. Verify `/api/health`, sign in, change the password if prompted, run booking-conflict tests in a staging database, verify doctor privacy, test payments/exports, and perform a backup restoration drill.

### Deploying to Vercel

This repository includes a Vercel function entry point at `api/index.js`. Vercel runs the Express app as a serverless function; local development continues to start the HTTP listener with `npm start`.

1. Import the GitHub repository into Vercel. Keep the project root set to the repository root and use the Node.js runtime.
2. Add these server-side environment variables for the Production environment (and Preview if you use preview deployments):
   - `DATABASE_URL`: a connection string for a managed PostgreSQL database reachable from Vercel. A local `localhost` database URL will not work.
   - `SESSION_SECRET`: a unique random secret with at least 32 characters.
   - `NODE_ENV=production`.
   - `SSL_MODE=require` if the database provider requires TLS. Do not set `COOKIE_SECURE=false` for an HTTPS deployment.
3. Apply the schema to the managed database once from a trusted machine or deployment shell using `npm run db:migrate` with that database's `DATABASE_URL`. Create the initial admin once with `npm run admin:create` and secure `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_PHONE`, and `INITIAL_ADMIN_PASSWORD` values. Do not commit these values or store them in client-side variables.
4. Deploy, then verify `https://<your-domain>/api/health` reports `database: connected`. Sign in and test the dashboard and other protected pages.

Vercel does not provide a persistent local PostgreSQL service. Use managed PostgreSQL with persistent storage and backups. Server-side sessions are stored in PostgreSQL, so do not remove the database or change `SESSION_SECRET` during normal operation; changing the secret signs active sessions out.

### External services and costs

Required services are Node.js hosting and PostgreSQL. They may be combined or supplied separately. No SMS, email, calendar-provider, or patient-system integration is needed by the included code. Optional future services could add SMS/email notifications or an authorized PPEC patient API integration. Provider prices vary by region, usage and plan; this project has no fixed vendor fee or provider account configured. Avoid choosing a plan without checking database backups, persistent storage, TLS, logs, and support expectations.

## Backups and recovery

With managed PostgreSQL, configure automated daily backups or point-in-time recovery according to the provider plan, restrict who can restore, and periodically test restoration into a separate database. For a local PostgreSQL instance, create a logical backup:

```bash
pg_dump "$DATABASE_URL" --format=custom --file="ppec-or-booking-$(date +%F).dump"
```

Restore to a separately prepared database (this command overwrites objects in the destination, so verify the target first):

```bash
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" ppec-or-booking-YYYY-MM-DD.dump
```

Store backups encrypted and separately from the app server; do not commit backup files. A restore is not verified until the database and app are tested after restoration.

## Tests and limitations

Run `npm test` for automated unit tests covering timezone conversion, invalid dates, overlap semantics, permitted session boundaries, 48-hour advance booking, 24-hour cancellation, commission maths, payment status and CSV formula injection. These tests do **not** replace integration tests against a real PostgreSQL database and browser acceptance testing.

Before launch, test in staging: concurrent bookings, database exclusion constraints/extensions, doctor account/password lifecycle, privacy between users, administrator overrides, closures/holidays, grouped and partial allocations, reversals, financial adjustments, date filters, CSV exports, mobile layout and database restore. Do not mark production readiness solely from unit-test results.

## Project structure

```text
ppec-operating-room-platform/
├── db/migrations/001_initial_schema.sql
├── public/index.html
├── public/styles.css
├── public/app.js
├── scripts/migrate.js
├── scripts/create-admin.js
├── src/db.js
├── src/domain.js
├── src/security.js
├── src/server.js
├── tests/domain.test.js
├── .env.example
├── docker-compose.yml
├── package.json
└── README.md
```
#   p p e c - r o o m - b o o k i n g  
 