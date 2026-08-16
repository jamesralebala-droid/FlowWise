# FlowWise — Operations Runbook (Phase 4: Hardening & Rollout, Phase 6–7 ops)

This document is the operating manual for the FlowWise backend. It covers the
Phase 4 checklist: **load testing, security hardening, restore/device testing,
data import, training, and the one-branch pilot** — plus the Phase 6–7
operations for mobile-money webhooks/payouts, FX rates, the supplier portal
and the web dashboard. The five invariants from the README are the ground
rules for every procedure here — especially "never edit data to fix a
problem".

---

## 1. Production deploy checklist

Run as the **migrator role** (`BYPASSRLS`), never as the API role:

```bash
bun run migrate          # apply backend/migrations/*.sql (001..011)
bun run seed:dev         # two-branch demo org: catalogue, suppliers, opening
                         # stock, reorder rules, 6 users (dev only; idempotent)
```

Then, on the database, ensure the API role has DML on every table — new
tables from new migrations are not covered by an earlier `ALL TABLES` grant:

```sql
-- after EVERY migration batch, re-run (or rely on ALTER DEFAULT PRIVILEGES):
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowwise_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowwise_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowwise_app;
```

Environment (all values, defaults in `backend/src/env.ts`):

| Var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(embedded PGlite)* | **Required in prod**; never run PGlite in prod |
| `JWT_SECRET` | dev constant | ≥ 32 chars; **required in prod** (boot fails without it) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `flowwise` / `flowwise-app` | Match the Android app config |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | 15 minutes per spec |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Rotation + family reuse detection |
| `AUTO_MIGRATE` | `true` | **Set `false` in prod** — migrate via `bun run migrate` |
| `PORT` | `4000` | Binds 0.0.0.0 |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Failed logins per account+IP before throttling |
| `AUTH_ATTEMPT_WINDOW_SECONDS` | `900` | Sliding window; failures age out after this |
| `RESEND_API_KEY` | *(unset)* | eReceipts; unset → emails recorded `skipped`, sales unaffected |
| `DODO_API_KEY` | *(unset)* | Mobile money; unset → `mock` provider (instantly confirms — demo only) |
| `DODO_WEBHOOK_SECRET` | *(unset)* | HMAC secret for `POST /v1/mobile-money/webhook`; unset → callbacks rejected |

Deploy smoke test after every release:

1. `GET /v1/healthz` → `{"status":"ok",...}`
2. A demo login (`POST /v1/oauth/authorize` + `/token`) succeeds
3. Ledger reconciliation (section 4) returns `delta = 0` for every row

## 2. Backup & restore

**Backup** (custom-format dump, roles intact but unowned):

```bash
DATABASE_URL=postgres://migrator:***@host/flowwise ./backend/scripts/backup.sh
# → backups/flowwise-<timestamp>.dump
pg_restore --list backups/flowwise-<stamp>.dump | head   # verify before trusting
```

Schedule this nightly + before every migration batch. Store offsite.

**Restore** (into a FRESH database — the script refuses to overwrite):

```bash
TARGET_DB_URL=postgres://migrator:***@host/flowwise_restore \
  ./backend/scripts/restore.sh backups/flowwise-<stamp>.dump
```

Roles are global; create `flowwise_migrator` / `flowwise_app` once on the
target server first (commands are in the script header). **Test this
procedure in staging at least monthly** — a backup you have never restored is
a hope, not a plan.

## 3. Health & monitoring

- `GET /v1/healthz` — liveness (public).
- Ledger reconciliation is the heartbeat of the product. Run it daily and
  alert if any row has a non-zero delta:

```sql
-- as migrator role; every row MUST have delta = 0
SELECT org_id, branch_id, variant_id, ledger_quantity, inventory_quantity, delta
FROM v_stock_reconciliation
WHERE delta <> 0;
```

- Audit trail: `GET /v1/audit` (permission `audit.read` — the auditor role)
  with optional `action`, `entityType`, `since`, `limit` filters.
- Watch `auth_attempts` for brute-force waves; the table keeps only hashed
  IPs and usernames, no secrets.

## 4. Security hardening notes (Phase 4)

- **Login throttling.** `POST /v1/oauth/authorize` counts failed attempts per
  (normalized username, hashed client IP) over a sliding window
  (`AUTH_ATTEMPT_WINDOW_SECONDS`). At `AUTH_MAX_FAILED_ATTEMPTS` failures the
  endpoint returns **429** *before* doing any credential work, so the
  throttle reveals nothing about whether an account exists. A successful
  login clears the streak. (Storage: `auth_attempts`, system table — no RLS,
  same treatment as `oauth_clients`.)
- **Device revocation is immediate.** Access JWTs live 15 minutes, but the
  auth guard re-checks the device row on every request, so a revoked device's
  token dies instantly; its refresh tokens are revoked in the same write.
- **Refresh rotation with family reuse detection.** Replaying a rotated
  refresh token revokes the whole family.
- **Secrets.** `JWT_SECRET` must be unique per environment and rotated by
  issuing a new value and redeploying (refresh tokens survive, sessions do
  not). Never put credentials in the repo or client.
- **Idempotency is a security property.** All writes accept
  `Idempotency-Key` / `client_operation_id`; a retried upload can never
  double-charge or double-deduct.

## 5. Load testing

```bash
bun run load:test
LOAD_WORKERS=16 LOAD_ITERATIONS=50 bun run load:test   # heavier
```

Boots the full API (embedded PGlite by default) and runs concurrent till
sessions against the sale path (login → server-priced sale → FEFO
allocation → ledger + audit writes). Reports sales/s and p50/p95/p99 sale
latency; exits non-zero on any request error, so it is CI-gateable.

> Caveat: embedded PGlite serializes transactions in-process. Absolute
> numbers are a smoke signal. For representative throughput set
> `DATABASE_URL` to a real PostgreSQL 15+ and run from a separate box.

## 6. Legacy data import (CSV)

```bash
DATABASE_URL=postgres://migrator:***@host/flowwise \
  bun run import:catalogue --file catalogue.csv --org botwise-demo --branch MAIN
```

CSV header (case-insensitive): `sku, name, variant, barcode, category, uom,
price, cost, opening_qty`. Only `sku`, `name`, `price` are required; supports
quoted fields, embedded commas, CRLF.

Semantics (all five invariants honoured):

- Runs as the migrator role in **one transaction** — a single bad row rejects
  the whole file, nothing half-applies.
- Products/variants/barcodes/prices **upsert** by deterministic keys, so
  re-running a file is a no-op for the catalogue.
- **Opening balances are `stock_ledger` rows** (`movement_type 'opening'`,
  written once per variant). Re-imports skip them; corrections afterwards go
  through GRNs / adjustments, never by editing the ledger.
- A barcode already mapped to a different variant rejects the file rather
  than silently re-pointing.

**Before the pilot:** reconcile the imported balances against the physical
count, then fix discrepancies with a *count*, not an edit.

## 7. Incident runbook

| Symptom | Procedure |
| --- | --- |
| Reconciliation delta ≠ 0 | Do **not** edit `stock_ledger` or `inventory_items`. Find the first divergent movement, then write a correcting adjustment/count so the audit trail explains itself. |
| Lost / corrupted database | Restore from the latest nightly dump into a fresh DB (section 2), verify reconciliation, then re-point `DATABASE_URL`. |
| Failed migration in prod | `AUTO_MIGRATE=false` in prod means boot is never blocked by a bad migration. Roll back the migration batch in staging, fix the SQL, redeploy. Migrations are checksummed in `schema_migrations`. |
| Brute-force wave | Confirm 429s in logs; consider lowering `AUTH_MAX_FAILED_ATTEMPTS`; audit `auth_attempts` volume; the device-revoke flow cuts off compromised tills. |
| Suspected data tampering | Audit trail + immutable documents mean tampering is visible: search `audit_log` for the affected entity, and compare ledger vs `v_stock_reconciliation`. |

## 8. One-branch pilot checklist

1. **Setup** — provision DB (PG 15+), run migrations as migrator, set env
   vars (prod values, `AUTO_MIGRATE=false`), configure `JWT_SECRET`.
2. **Import** — load the branch's catalogue + opening stock from CSV, then
   perform and post a physical stock count to lock the baseline.
3. **Devices** — register the till(s); verify a stolen/revoked till is cut
   off within one request.
4. **Dry run** — one week of parallel running: ring sales on FlowWise *and*
   the old system; reconcile daily. The ledger sum must equal the physical
   count at every cash-up.
5. **Offline drill** — run the till with the network off for a full trading
   day (Phase 2 exit), then reconnect and verify the outbox flush reconciles
   with zero duplicates (idempotency keys).
6. **Load check** — `bun run load:test` against the staging DB; confirm the
   p95 sale latency stays inside the till's acceptable range during peak.
7. **Backup drill** — restore a backup into a scratch DB and boot the API
   against it (section 2).
8. **Go live** — cut over after acceptance: no critical reconciliation
   defect for the parallel week, all drills green.

## 9. Training plan (per role)

- **Cashiers (30 min):** login + branch select, scan/sell/refund, shift open
  and cash-up, what "offline" means (the till never stops), why receipts
  matter.
- **Stock controllers (45 min):** GRNs (incl. partial PO receipts), counts
  (blind), adjustments + approval flow, transfers, low-stock alerts, outbox
  behaviour during outages.
- **Branch managers (45 min):** reorder rules + suggestions → POs, supplier
  scorecard, reports, devices (register/revoke).
- **Owners/admins (30 min):** settings (currency/timezone/VAT), users &
  roles per branch, audit log, backup expectations.
- **Auditors (20 min):** read-only access, `GET /v1/audit`, reconciliation
  report, immutability guarantees.

## 10. Phase 6 operations (mobile money, web dashboard)

- **Mobile-money webhook.** In production set `DODO_WEBHOOK_SECRET` (and
  `DODO_API_KEY`). The gateway must POST to
  `https://<api>/v1/mobile-money/webhook` with header `x-dodo-signature`
  (hex HMAC-SHA256 of the raw body using the same secret). Without the
  secret every callback is rejected — a deliberately default-deny path.
  Payment statuses are also pullable via `GET /v1/mobile-money/payments`,
  so a lost webhook never loses money: confirm the row on the till by
  polling.
- **Reconciliation for mobile money.** A `pending` payment whose sale has
  already committed is *not* a broken sale — the payment row is
  best-effort. Investigate via the audit trail (`mobile_money.initiate` /
  `mobile_money.failed` actions) and re-initiate or settle the difference
  manually. Never edit the row to "fix" it.
- **Web dashboard.** Static Vite build in `web/dist` (host it on any static
  host; e.g. Netlify/Vercel). Set `VITE_API_BASE_URL` at build time to the
  public API origin. The backend currently exposes `app.enableCors()` (all
  origins) — tighten it to the dashboard origin in `src/main.ts` before a
  public deploy. Sessions are browser `sessionStorage`, so a closed tab is a
  logout; no server-side state.
- **Loyalty/promotions are money.** Points earn/redeem and promotion usage
  counters are append-only rows inside sale transactions; a refund reverses
  them exactly. If balances ever look wrong, audit `loyalty_transactions`
  and `promotions.times_used` against the sales — never "adjust" a points
  balance directly.

## 11. Phase 7 operations (payouts, FX, supplier portal, APKs)

- **Payouts are refunds-to-wallet.** A refund of a mobile-money-paid sale
  creates a `mobile_money_payouts` row in the refund transaction (status
  `pending`); the provider `refund()` runs after commit and the gateway
  confirms via the same signed webhook (payout events carry `payout` instead
  of `payment` in the body) or the status pull (`GET /v1/mobile-money/payouts`).
  A `failed` payout means the refund already happened on the ledger and the
  till — re-initiate or settle manually. Never edit the payout row to "fix"
  it; use the audit trail (`mobile_money.refund` / `mobile_money.refund_failed`).
- **FX rates are money.** `rate_to_base` is base units per 1 foreign unit
  (e.g. ZAR 0.74 → P0.74 buys R1). The base currency rate is pinned at 1.
  Tenders snapshot the rate on the row, so a rate change never reprices a
  historic receipt; reports/ledgers stay in base currency. Owner-only edits,
  audited (`currency.update`).
- **Supplier portal credentials.** Supplier logins are per-supplier
  (`supplier_users`, one per supplier entity) and share the staff brute-force
  throttle. Tokens are 24h (`SUPPLIER_TOKEN_TTL_SECONDS`) with no refresh —
  re-login on expiry. Onboarding = create the `supplier_users` row with a
  bcrypt hash (`bun run seed:dev` seeds one per demo supplier:
  `<code>@flowwise.demo`). Suppliers can only see/edit their own data; the
  `price-list` PUT is audited and feeds GRN/PO cost hints.
- **APK distribution.** Debug APK is a CI artifact on every run (14 days);
  release (minified, unsigned) via `workflow_dispatch` or a `v*` tag (30
  days). Wire a signing config + keystore secrets into
  `android/app/build.gradle.kts` before public distribution.
