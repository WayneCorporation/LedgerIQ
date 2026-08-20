# Production deployment runbook

This runbook takes ledgerIQ from a tested repository to a public, paid PostgreSQL-backed service. It does not authorise high-availability or Enterprise recovery claims; those require redundant workers and measured recovery objectives described below.

## 1. External ownership gates

Create these accounts in the company's name, require MFA and keep at least two administrators where the provider supports it:

- domain registrar and DNS;
- source-control organisation and protected `main` branch;
- Render or another Docker host;
- private S3-compatible object storage;
- Resend, Paystack, monitoring and uptime monitoring;
- an HTTPS offsite-backup receiver with retention/versioning;
- a password manager or managed secret vault.

Do not reuse passwords or application encryption keys between providers. Record account recovery and billing ownership.

## 2. Required production configuration

Generate `SESSION_SECRET`, `INTEGRATION_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` independently with a cryptographically secure generator. Each must be at least 32 characters. Losing the integration or backup keys makes the corresponding encrypted data unrecoverable.

Set and verify:

```text
NODE_ENV=production
APP_ORIGIN=https://your-production-domain
DATABASE_URL=<managed PostgreSQL connection string>
SESSION_SECRET=<unique secret>
INTEGRATION_ENCRYPTION_KEY=<different unique secret>
BACKUP_ENCRYPTION_KEY=<different unique secret>
REQUIRE_EMAIL_VERIFICATION=true
TRUST_PROXY=true                # only behind the host's trusted proxy
RESEND_API_KEY=<live key>
MAIL_FROM=ledgerIQ <verified@your-domain>
PAYSTACK_SECRET_KEY=<live key>
PAYSTACK_MONTHLY_PLAN_CODE=<R599 plan>
PAYSTACK_ANNUAL_PLAN_CODE=<R5990 plan>
MONITORING_DSN=<Sentry DSN or HTTPS JSON collector>
OFFSITE_BACKUP_URL=<HTTPS PUT receiver>
OFFSITE_BACKUP_TOKEN=<receiver token, when required>
```

Use the `OBJECT_STORAGE_*` variables for customer documents. `OBJECT_STORAGE_PATH` is acceptable only for a controlled single-instance pilot with a durable mounted volume.

Optional Xero, Stitch, payroll and integration-gateway variables should remain unset until the corresponding production account has been approved and tested.

## 3. Email and DNS

Verify the sending domain with Resend. Publish SPF and DKIM, add a DMARC policy and confirm that verification, password-reset, invitation and invoice messages arrive at multiple mailbox providers. Create and monitor the real support, privacy, security and sales addresses used by the website and contracts.

## 4. Billing

Create live monthly and annual Paystack plans with the documented ZAR amounts. Register `https://your-production-domain/api/billing/webhook`, then test subscription creation, a successful renewal, payment failure, cancellation and a duplicate delivery. Confirm that an event for an unknown plan cannot activate a tenant. Reconcile the first settlement to the business bank account before opening general signup.

## 5. Deployment

For the included Render blueprint:

1. Connect the source repository and apply `render.yaml`.
2. Supply every `sync: false` secret in the Render dashboard.
3. Attach the production domain and wait for TLS issuance.
4. Deploy to staging first and run `npm test` plus the smoke tests below.
5. Protect `main`, require the CI check and enable deployment only after checks pass.

The Render blueprint uses managed PostgreSQL. Keep one web instance until recurring jobs, provider sync and webhook delivery use distributed leases; otherwise multiple processes could perform the same queued work.

To move an existing local SQLite workspace into an empty PostgreSQL database, stop the web service and run:

```sh
DATABASE_URL='postgresql://...' npm run migrate-postgres -- data/ledgeriq.sqlite
```

The importer initializes the PostgreSQL schema, refuses a non-empty target, copies records transactionally and resets generated ID sequences. Keep the original SQLite file until reconciliation and a PostgreSQL backup restore both succeed.

## 6. Smoke and security checks

After every production deployment, confirm:

- `/api/health` returns HTTP 200;
- `/api/ready` returns HTTP 200 after the monitoring check and offsite backup complete;
- `/server.js`, `/.env`, `/data/ledgeriq.sqlite` and `/backups/anything.sqlite` return HTTP 404;
- registration, email verification, login, MFA, password reset and logout work;
- an unverified account cannot mutate finance data;
- tenant data cannot be read through another tenant or company;
- Paystack checkout uses the expected live plan and webhook replay is idempotent;
- a webhook to localhost, RFC1918 space or cloud metadata is rejected;
- document upload, download and deletion work in production object storage;
- graceful restart retains records and does not corrupt the database.

## 7. Backup and recovery

The service creates a daily PostgreSQL custom-format dump (or a SQLite snapshot in local fallback mode), encrypts it with AES-256-GCM and uploads it with HTTPS `PUT`. The receiver must return a successful HTTP status only after durable storage. Configure object versioning, retention and access alerts at that receiver.

Quarterly—and before promising any recovery target—download an encrypted backup, retrieve the encryption key separately, and restore it without overwriting an existing file:

```sh
BACKUP_ENCRYPTION_KEY='retrieved-separately' npm run restore-backup -- downloaded.dump.enc restored.dump
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" restored.dump
```

Restore into an isolated environment, run database integrity checks and reconcile representative tenant totals. Record measured recovery point and recovery time. The receiver-specific download operation must be documented for the selected provider; an upload succeeding is not a restore drill.

## 8. Monitoring and response

Create alerts for failed readiness, HTTP 5xx rate, process restarts, backup failures, disk usage, webhook backlog and provider sync failures. Route alerts to a staffed channel and name a primary and backup responder. Test one alert and one escalation before launch. Never promise 24/7 support without a staffed rota.

## 9. Legal and commercial launch gate

South African counsel must approve the Terms, Privacy Notice, POPIA DPA, PAIA materials, ECTA disclosures, refund language, limitation of liability, Enterprise agreement and SLA. Replace every placeholder with the registered operator, registration/VAT status, address, Information Officer, actual subprocessors and cross-border safeguards. Confirm the ledgerIQ name/domain, insurance position and controlled support/privacy mailboxes.

Launch payment only after a responsible person signs a dated checklist confirming legal approval, provider production tests, a successful restore drill, alert escalation, rollback and customer-support ownership.

## 10. Enterprise/high-availability gate

Before promising horizontal scaling, strict RPO/RTO or Enterprise availability:

- use managed PostgreSQL with point-in-time recovery and tested failover;
- move recurring work, provider sync and webhook delivery to a durable queue with worker leases;
- use shared distributed rate limiting;
- run multiple stateless web instances behind a load balancer;
- complete load, failover, penetration and disaster-recovery testing.

Until that programme is complete, sell Enterprise as a scoped design-partner pilot without high-availability claims.
