# ledgerIQ Enterprise launch playbook

The application is the technical foundation. The following third-party and human steps turn it into a service you can responsibly sell from R10,000 per month.

## 1. Bank feed and provider approval

Recommended initial path: use Stitch for South African bank data and keep CSV import as the fallback.

1. Register the company and open its business bank account first; provider onboarding will ask for legal and beneficial-owner details.
2. Apply to Stitch for a production solution and explain the use case: read-only account and transaction data for customer-authorised bookkeeping and reconciliation.
3. Request the smallest necessary products/scopes. Do not request payment initiation until the product genuinely needs it.
4. Supply production domain, privacy notice, terms, support contact, redirect URLs and the consent journey requested during review.
5. Complete sandbox testing, security review, pricing agreement, DPA and production approval.
6. Store the issued access token/approved GraphQL query through **Enterprise → Provider connections → Configure**. The app encrypts these credentials and queues provider syncs.
7. For each customer, record explicit authorisation, connected accounts, consent expiry/revocation and the responsible contact. Test disconnect and deletion.

Do not market a live automatic bank feed until Stitch has approved the solution and production credentials work. The existing manual account/transaction import remains usable meanwhile.

## 2. Accounting and payroll credentials

### Xero

1. Create a Xero developer account and OAuth 2 app.
2. Set the callback/redirect URI to `https://YOUR-DOMAIN/api/enterprise/oauth/xero/callback`, configure the three `XERO_*` environment variables, then use **Authorise Xero** in Provider Connections. ledgerIQ exchanges the code, discovers the authorised tenant and rotates refresh tokens automatically.
3. Request read-only access needed for contacts, invoices and bank transactions. Add write permissions only when a customer has approved two-way sync behavior.
4. Implement token refresh before production rollout; short-lived access tokens must never be treated as permanent credentials.
5. Test with a Xero demo organisation, then follow Xero's app-partner/certification requirements before connecting customers at scale.

### Payroll

1. Choose one launch partner rather than claiming universal payroll support. Ask PaySpace or Sage for partner/API access, sandbox, API specification, rate limits, permitted data and commercial terms.
2. Sign the provider DPA and define whether ledgerIQ imports only aggregate payroll runs or employee-level personal information. Aggregate-only is the safer first release.
3. Set `PAYROLL_API_BASE_URL`, then save the provider token and approved runs path on the encrypted connection.
4. Test month-end, reversals, duplicate imports, terminated employees, access revocation and audit evidence.

## 3. Production hosting accounts

Create accounts owned by the company, protected by MFA, with at least two administrators:

- a domain/DNS account;
- a container hosting account capable of running the Dockerfile;
- a managed production database and a separate managed backup destination;
- private object storage for uploaded documents;
- transactional email, monitoring/error tracking and uptime monitoring;
- a password manager/secrets vault and source-control organisation.

Set every value in `.env.example`, use a 32+ character random session secret and a separate 32+ character integration-encryption key, force HTTPS, restrict admin access, enable automated encrypted backups and perform a documented restore drill. Configure `DATABASE_URL` for managed PostgreSQL. Before promising horizontal scaling or strict Enterprise recovery targets, add durable worker leases, distributed rate limiting, measured failover and point-in-time recovery.

## 4. Payment provider

Recommended launch path: Paystack hosted checkout so ledgerIQ never handles card details.

1. Open and verify a South African Paystack business account using the company's registration, bank and responsible-person documents.
2. Create recurring plans for **Business monthly (R599)** and **Business annual (R5,990)**. Enterprise customers should sign an annual order form and may be invoiced by EFT instead of self-serve checkout.
3. Copy the live secret key and plan codes into `PAYSTACK_SECRET_KEY`, `PAYSTACK_MONTHLY_PLAN_CODE` and `PAYSTACK_ANNUAL_PLAN_CODE`.
4. Register `https://YOUR-DOMAIN/api/billing/webhook` and verify subscription activation, failed payment, cancellation and replay behavior in production mode.
5. Reconcile Paystack settlements to the business bank account and accounting system; document refunds and chargeback ownership.

## 5. Legal and compliance sign-off

Before taking money, give a South African technology/privacy lawyer the starter Terms and Privacy Notice plus the templates in this folder. Ask them to finalise:

- Master Services Agreement, Enterprise order form, SLA and acceptable-use terms;
- POPIA Data Processing Agreement, operator obligations, security schedule and subprocessor list;
- data retention/deletion, breach response and cross-border transfer provisions;
- ECTA supplier disclosures, cancellation/refund wording and electronic contracting;
- liability cap, indemnities, IP, confidentiality, exit assistance and dispute terms;
- PAIA manual, Information Officer registration, privacy request process and incident plan;
- VAT treatment, invoice wording, company/domain/trademark checks and employment/contractor documents.

Counsel must insert the actual legal entity, addresses, registration/VAT details, insurers, chosen providers and negotiated liability. Code cannot provide legal sign-off.

## 6. Onboarding and dedicated support

For the first three to five customers, the founder should lead sales discovery and onboarding with a part-time accountant/bookkeeper as the domain specialist. Contract a senior developer or managed operations provider for production incidents. Do not advertise 24/7 support until an actual staffed rota exists.

At roughly five active Enterprise customers, appoint one implementation/customer-success specialist. Their job is discovery, data mapping, configuration, training, go-live and adoption. Add a support engineer when incident and integration volume can no longer be handled within the signed response targets.

Use `ONBOARDING_RUNBOOK.md` for every customer and `SLA_TEMPLATE.md` only after confirming that hosting, monitoring and people can meet its targets.

## Launch gate

The Enterprise tier can be sold when one real customer completes a sandbox-to-production integration, backup restore, access review, incident exercise, onboarding rehearsal and signed MSA/order form. Until then, sell it as a paid design-partner pilot with a tightly scoped implementation statement.

## Official setup references

- [Stitch developer documentation](https://docs.stitch.money/) and [authentication](https://docs.stitch.money/authentication/introduction)
- [Xero OAuth 2 overview](https://developer.xero.com/documentation/guides/oauth2/overview), [scopes](https://developer.xero.com/documentation/guides/oauth2/scopes) and [Accounting API](https://developer.xero.com/documentation/api/accounting/overview)
- [Paystack subscriptions](https://paystack.com/docs/payments/subscriptions/) and [Subscription API](https://paystack.com/docs/api/subscription/)
- [Render Docker deployment](https://render.com/docs/docker), [persistent disks](https://render.com/docs/disks) and [managed PostgreSQL](https://render.com/docs/postgresql)
- [Protection of Personal Information Act](https://www.justice.gov.za/legislation/acts/2013-004.pdf), [Information Regulator](https://inforegulator.org.za/home-2/), [ECTA](https://www.gov.za/documents/electronic-communications-and-transactions-act) and [SARS tax-invoice checklist](https://www.sars.gov.za/wp-content/uploads/Docs/Government/Tax-Invoice-Checklist-Version-2-29032016.pdf)
