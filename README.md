# ledgerIQ

ledgerIQ is a focused invoicing, expense and cash-flow SaaS for freelancers and small businesses. It runs on Node.js 22+ and supports PostgreSQL in production with a zero-configuration SQLite fallback for local development.

## Run locally

1. Copy `.env.example` to `.env`.
2. Replace `SESSION_SECRET` with at least 32 random characters.
3. Run `npm start`.
4. Open `http://localhost:3000` for the landing page or `/app` for the product.

Without `DATABASE_URL`, data is stored in `data/ledgeriq.sqlite`. With `DATABASE_URL`, ledgerIQ initializes and uses PostgreSQL. Daily rolling seven-day SQLite snapshots or PostgreSQL custom-format dumps are stored in `backups/`; configured offsite copies are encrypted before upload.

## Production configuration

- `NODE_ENV=production` enables secure cookies and HSTS.
- `APP_ORIGIN` must be the exact HTTPS production origin.
- `SESSION_SECRET` must be a unique high-entropy production secret.
- `RESEND_API_KEY` and `MAIL_FROM` enable invoice email delivery through Resend.
- `BILLING_MONTHLY_URL` and `BILLING_ANNUAL_URL` are the hosted checkout URLs shown to customers.
- `BILLING_WEBHOOK_SECRET` signs billing status updates sent to `/api/billing/webhook` using the `x-ledgeriq-signature` HMAC-SHA256 header.
- `PAYSTACK_SECRET_KEY` plus the monthly and annual plan codes enable Paystack subscription checkout and signed webhooks.
- `INTEGRATION_ENCRYPTION_KEY` encrypts provider credentials and webhook secrets at rest.
- `STITCH_GRAPHQL_ENDPOINT`, `PAYROLL_API_BASE_URL` and the optional integration-gateway variables activate provider adapters.
- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and `XERO_REDIRECT_URI` activate Xero OAuth and token rotation.
- The `OBJECT_STORAGE_*` variables activate private S3-compatible document storage; `OBJECT_STORAGE_PATH` is the local fallback.
- `MONITORING_DSN` and `OFFSITE_BACKUP_URL` are included in the in-app readiness assessment.
- `BACKUP_ENCRYPTION_KEY` encrypts every offsite backup independently from application credentials; `OFFSITE_BACKUP_TOKEN` authenticates the HTTPS upload when required.
- `REQUIRE_EMAIL_VERIFICATION` can enforce verification outside production; production enforces it by default unless explicitly set to `false`.
- `TRUST_PROXY=true` uses the first proxy-provided client address for rate limiting and audit context. Enable it only behind a trusted reverse proxy.
- Put the service behind an HTTPS reverse proxy and persist both `data/` and `backups/` on separate durable storage.

`GET /api/health` is a liveness probe. `GET /api/ready` checks the database and data directory and, when configured, requires a successful monitoring check and encrypted offsite backup upload.

## Pricing decision

ledgerIQ has two commercial motions: **ledgerIQ Business at R599/month or R5,990/year**, with a 30-day trial, and **ledgerIQ Enterprise from R10,000/month** under an annual order form plus scoped implementation. Business is the full self-service finance-operations product; Enterprise adds multiple companies, governed workflows, integrations, API access and SLA options.

## Security and data controls

- Passwords use `scrypt` with per-user salts.
- Email verification, expiring password resets and authenticator-app MFA are built in.
- Sessions are opaque, hashed in the database, HttpOnly and SameSite Strict.
- Every business record is scoped to a tenant on the server.
- Mutation requests enforce same-origin checks.
- CSP, HSTS in production, clickjacking, MIME-sniffing and permissions headers are set.
- Authentication endpoints are rate-limited.
- Customers can export all workspace data and permanently delete their account.
- API POST requests require idempotency keys and safely replay the first response.
- Uploaded documents use a type/size allowlist and SHA-256 integrity checksum.

The service delivers errors to a Sentry-compatible DSN (or generic HTTPS JSON endpoint) and uploads AES-256-GCM encrypted database backups to an HTTPS `PUT` endpoint. PostgreSQL is selected automatically when `DATABASE_URL` is set. These integrations still require real provider accounts, alert rules, retention settings and a successful restore drill.

## Enterprise platform

The Enterprise control centre includes multi-company workspaces, role-based teams, invitations, amount-based multi-approver policies, notifications, audit logs, Xero OAuth, encrypted provider connections, queued bank/accounting/payroll sync, reconciliation, a balanced double-entry ledger, chart of accounts, immutable journals, accounting-period locks, trial-balance data, profit-and-loss and balance-sheet summaries, business documents, payroll summaries, S3-compatible files, recurring records, scoped API keys, signed outbound webhooks and delivery history.

API usage and webhook verification are documented at `/developers`.

Read [docs/ENTERPRISE_LAUNCH.md](docs/ENTERPRISE_LAUNCH.md) for the provider-account, hosting, legal and staffing work that cannot be completed from source code. Use the included onboarding and SLA starters during customer contracting.

## Billing connection

The app uses Paystack hosted checkout and verifies Paystack's signed subscription webhooks instead of handling card data. Generic hosted-checkout URLs and an HMAC webhook boundary remain available as a fallback. Supported internal status values are `active`, `past_due`, and `cancelled`.

## Legal launch checklist

The privacy notice and terms are substantive starter documents, but they contain clearly marked fields that cannot be completed from source code. Before accepting payment:

- insert the operator’s legal name, legal status, registration number, physical address, phone, office bearers and place of registration;
- appoint and register the Information Officer;
- list actual hosting, email, monitoring and payment subprocessors and cross-border safeguards;
- have South African counsel approve the Terms, Privacy Notice, PAIA/POPIA materials, refund wording and liability terms;
- confirm VAT registration status and whether displayed prices include VAT;
- replace `support@ledgeriq.app` and `privacy@ledgeriq.app` if those mailboxes are not controlled;
- verify ownership/availability of the ledgerIQ name and domain.

## Verification

Run `npm test`. The end-to-end test covers authentication, tenant and company isolation, roles, invitations, approvals, integrations, reconciliation, documents, payroll, file storage, recurring work, API keys, audit, export and protected access.

## Deploy

- `render.yaml` defines a Render service backed by managed PostgreSQL and a persistent operations disk.
- `compose.yaml` provides a hardened local container deployment with PostgreSQL 17 and separate data, backup and database volumes.
- `.github/workflows/ci.yml` runs the test suite and builds the production image for every pull request.

Follow [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md) for secrets, provider setup, smoke tests, backup verification and the remaining external launch gates.

On Windows, after Docker Desktop installation and the required WSL restart, run `powershell -ExecutionPolicy Bypass -File scripts/finish-docker-setup.ps1`. It creates local development secrets when needed, starts PostgreSQL 17, runs the complete SQLite and PostgreSQL test matrix, builds the image and starts ledgerIQ.
