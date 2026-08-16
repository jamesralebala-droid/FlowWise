# FlowWise

Offline-first, Android-primary sales, stock and reordering for multi-branch
Botswana SMEs — a **BotWise Technologies** product (sister to RunWise). The
till keeps selling with zero network for days; when connectivity returns,
everything reconciles exactly, replay-safe, against a single source of truth.

[![CI](https://github.com/jamesralebala-droid/FlowWise/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesralebala-droid/FlowWise/actions/workflows/ci.yml)

> **Status: Phase 0 (Foundation) ✅ + Phase 1 (POS core) ✅ + Phase 2
> (Inventory ops) ✅ + Phase 3 (Procurement & intelligence) ✅ + Phase 4
> (Hardening & rollout) ✅ — implemented & test-verified in this repo.**
> Backend: NestJS + PostgreSQL 15+ (migrations, RLS, OAuth2 PKCE, ledger
> invariants, sales/shifts/outbox/reports, GRN/batches/FEFO/counts/transfers/
> adjustments, reorder rules/suggestions, purchase orders with partial
> receipts, supplier scorecard, webhooks; Phase 4: login throttling, audit
> API, CSV data import, load test, backup/restore runbook). Android:
> source-only skeleton (needs Android Studio to build).

## The five invariants (non-negotiable)

1. **`stock_ledger` is the only source of truth** — append-only, enforced by a
   statement-level trigger. Corrections are new, linked reverse movements.
2. **`inventory_items` is a derived cache** — maintained exclusively by the
   `apply_stock_ledger()` trigger on ledger insert; clients have no write path.
3. **A document and its ledger entries commit in one transaction** (sales,
   GRNs, adjustments, transfer legs, counts).
4. **Every write is idempotent** — `Idempotency-Key` header, per-org unique
   `idempotency_key` on movements, unique `client_operation_id` on sales.
5. **A completed sale is immutable** — refund/void/adjustment only.

## Repo layout

```
backend/          NestJS + TypeScript API (REST /v1)
  migrations/     001 tenancy/RBAC/OAuth/RLS · 002 catalogue · 003 ledger
                 · 004 sales · 005 shifts/cash-up · 006 inventory ops
                 · 007 procurement · 008 hardening (throttle, data import)
  src/            db layer, OAuth2 PKCE, guards, catalogue, idempotency,
                  sales, shifts, outbox, reports, audit, import, inventory
                  (suppliers, GRNs, transfers, counts, adjustments, stock
                  views), procurement (reorder rules/evaluator, POs,
                  webhooks, scorecard)
  test/           PGlite-backed integration tests (RLS, ledger, OAuth,
                  catalogue, sales, shifts, outbox, reports, inventory,
                  FEFO, procurement, import, throttling)
  scripts/        test.sh · loadtest.ts · backup.sh · restore.sh
android/          Kotlin + Jetpack Compose app skeleton (Room/SQLCipher, WorkManager, ML Kit)
docs/OPS.md       Operations runbook: deploy, backup/restore, monitoring,
                  incident response, pilot + training checklists
```

## Backend quickstart

Requires Bun. PostgreSQL is the production database; without a
`DATABASE_URL`, the API boots on embedded PostgreSQL (PGlite) with migrations
auto-applied — convenient for the sandbox preview, never for production.

```bash
bun install          # workspace install (root)
bun run dev          # API on 0.0.0.0:${PORT:-4000}, auto-migrates
bun run test         # integration tests (RLS, 10k-ledger, OAuth, catalogue,
                     # sales, shifts, outbox, reports, inventory, FEFO,
                     # procurement, import, throttling)
bun run typecheck    # tsc -b --noEmit
bun run build        # tsc -> backend/dist
bun run load:test    # smoke load test against the POS sale path
DATABASE_URL=... bun run import:catalogue --file catalogue.csv \
    --org <slug> --branch <code>   # legacy CSV import (see docs/OPS.md §6)
```

Against a real Postgres 15+ (as the migrator role, BYPASSRLS):

```bash
bun run migrate      # apply backend/migrations/*.sql
bun run seed:dev     # realistic multi-branch demo (idempotent)
```

The demo seed builds a two-branch retail organisation (`botwise-demo`: MAIN +
PHK, BWP / Africa/Gaborone / 14% VAT) with a ~16-item catalogue (barcodes,
BWP prices, supplier mappings), ledger-backed opening balances, per-branch
reorder rules — GRO-001 is deliberately below its reorder point on MAIN so
the first reorder evaluation shows live suggestions — and six users
(password `Password123!`): `owner@`, `manager@`, `cashier@` (MAIN),
`cashier2@` (PHK), `stock@`, `auditor@flowwise.demo`. Re-running the seed is
a no-op (verified by `test/seed.test.ts`). The Android app uses OAuth client
`flowwise-app`.

### Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | *(embedded PGlite)* | PostgreSQL 15+ connection string |
| `JWT_SECRET` | dev-only constant | HS256 signing key, ≥ 32 chars, required in prod |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `flowwise` / `flowwise-app` | Token validation |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime (15 min per spec) |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh lifetime (rotation + family reuse detection) |
| `PORT` | `4000` | Listen port (binds 0.0.0.0; Freebuff injects it) |
| `AUTO_MIGRATE` | `true` | Run migrations on boot (keep off in prod) |
| `OAUTH_CLIENT_ID` | `flowwise-app` | Public client used by the app |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Failed logins per account+IP before 429 (Phase 4) |
| `AUTH_ATTEMPT_WINDOW_SECONDS` | `900` | Throttle sliding window; failures age out |

**Production setup notes:** run migrations and seeds as a BYPASSRLS migrator
role; run the API as a role granted table DML on the `public` schema (RLS
enforced). The SECURITY DEFINER login/token-lookup functions are owned by the
migrator role. Money/quantity are `numeric(14,4)` everywhere — no floats.

### Phase 0 exit criteria (verified by `bun run test`)

- ✅ Cross-tenant reads/writes fail (RLS tests, org A vs org B)
- ✅ OAuth2 Authorization Code + PKCE, 15-min JWTs with org+permission claims,
      refresh rotation with family reuse detection, device register/revoke
- ✅ `GET /v1/me` — profile, roles, branch scope (branch selection basis)
- ✅ Catalogue pull + barcode→price resolution, branch-scoped
- ✅ 10,000 mixed movements → `inventory_items` equals ledger sum; duplicate
      `idempotency_key` rejected with zero side effects; UPDATE/DELETE blocked
- ⏳ Android skeleton is source-only — build it with Android Studio locally

### Phase 1 API (scaffold — verified by `bun run test`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `POST /v1/sales` | `pos.sell` | Server-priced sale; `shiftId` optional; sale + ledger rows in one tx |
| `POST /v1/sales/:id/refund` | `pos.refund` | New refund document + reverse ledger rows (idempotent) |
| `GET /v1/sales?branchId&since&limit` | `sales.read` | Pull half of outbox sync — completed sales since a cursor |
| `POST /v1/shifts` | `shift.open` | Open a till shift with the opening float (one open per branch) |
| `POST /v1/shifts/:id/close` | `shift.close` | Cash-up: declared vs server-computed expectations + variance |
| `GET /v1/shifts[?branchId&status]` / `:id` | `sales.read` | Shift history / detail |
| `POST /v1/outbox` | any authenticated | Batch-flush offline queue; per-op permissions + idempotency |
| `GET /v1/reports/sales-summary` | `reports.read` | Period totals, tender breakdown, refunds netted |
| `GET /v1/reports/daily-sales` | `reports.read` | Per-day buckets in the org timezone |

Shifts: `expected_total = opening float + Σ sales − Σ refunds`, computed in
SQL at close; `variance = Σ declared − expected_total`. Closed shifts are
immutable (trigger), and sales cannot attach to a closed shift. Refund
tender-type allocation is a Phase 2 refinement (refunds currently net against
`expected_total` only).

### Phase 2 API (inventory ops — verified by `bun run test`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `POST /v1/suppliers` · `PUT /:id` · `PUT /:id/products` | `stock.grn` | Supplier reference + variant mappings (cost hints) |
| `GET /v1/suppliers` / `:id` | `stock.read` | Suppliers with mapped products |
| `POST /v1/grns` · `POST /:id/post` | `stock.grn` | Draft → posted GRN; batch metadata + ledger in one tx |
| `GET /v1/grns[?branchId&status]` / `:id` | `stock.read` | GRN history / detail (includes `batchId`) |
| `POST /v1/transfers` · `POST /:id/post` | `stock.transfer` | Draft → posted transfer; **both** ledger legs in one tx |
| `POST /v1/counts` · `POST /:id/record` | `stock.count` | Blind count: open (expected hidden) → record counted |
| `POST /v1/counts/:id/post` | `stock.count.approve` | Approve: server snapshots expected, variance → ledger movement |
| `POST /v1/adjustments` | `stock.adjust` | Record a draft adjustment (increase/decrease) |
| `POST /v1/adjustments/:id/post` | `stock.adjust.approve` | Approve: signed ledger movements; decrease can't go below zero |
| `GET /v1/stock/balances` | `stock.read` | Per-branch balances (derived cache) |
| `GET /v1/stock/batches?branchId` | `stock.read` | Per-branch batch balances (FEFO order) |
| `GET /v1/stock/low-stock?branchId` | `stock.read` | Reorder-configured variants at/below threshold |
| `GET /v1/stock/ledger[?branchId&since]` | `stock.read` | Append-only ledger feed |

### Phase 3 API (procurement & intelligence — verified by `bun run test`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `POST /v1/reorder/rules` · `GET /v1/reorder/rules` | `purchase.reorder` | Upsert (per branch+variant) / list reorder rules (point, qty, lead time, safety, demand window) |
| `POST /v1/reorder/evaluate` | `purchase.reorder` | **Explanable evaluator**: trailing-window avg daily demand → suggestions with `daysOfCover`, inputs and a readable `reason`; open suggestions refresh in place |
| `GET /v1/reorder/suggestions` · `POST /:id/dismiss` | `purchase.reorder` | Suggestion list (open/converted/dismissed) / dismiss |
| `GET /v1/reorder/forecast?branchId` | `purchase.reorder` | Per-variant average daily demand + days of cover over the trailing window |
| `POST /v1/purchase-orders` | `purchase.po` | Draft PO from an **open suggestion** (exit flow) or explicit lines; `client_operation_id` replay-safe |
| `POST /v1/purchase-orders/:id/send` · `/cancel` | `purchase.po.approve` / `purchase.po` | draft → sent (webhook `po.sent`) / draft → cancelled |
| `POST /v1/grns` (with `poId`) · `/:id/post` | `stock.grn` | **Partial receipts**: GRN ledger rows + PO `received_quantity` in one tx; overshoot rejected (service + DB trigger) |
| `GET /v1/purchase-orders[?branchId&status]` / `:id` | `purchase.po` | PO history / detail with received + outstanding per line |
| `GET /v1/suppliers/scorecard` | `purchase.po` | Derived scorecard: PO count, fully-received count, ordered vs received value, avg lead time, on-time rate |
| `POST /v1/webhooks` · `GET` · `DELETE /:id` · `/:id/test` · `GET /:id/deliveries` · `POST /deliveries/:id/retry` | `purchase.webhook` | Signed (HMAC-SHA256) outbound PO events with persisted deliveries, retry + backoff |

**Phase 3 notes:**

- **Suggestion → PO is the exit flow.** `POST /v1/purchase-orders {suggestionId}`
  converts an open suggestion in the same transaction that creates the PO
  (status flips to `converted`, `converted_po_id` set); replaying the create
  returns the stored PO, and the evaluator never resurrects converted items.
- **Receipts live on the GRN path** — a GRN with `poId` allocates
  `received_quantity` and recomputes the PO status (`sent →
  partially_received → received`) inside the posting transaction, so the
  ledger movement and PO bookkeeping can never diverge (Invariant 3).
- **Sent POs are immutable** (DB trigger): only receipt-progress status
  changes; `received`/`cancelled` are terminal.
- **Webhooks** deliver in-process after the emitting transaction commits;
  every attempt is persisted with exponential backoff (max 5) and a manual
  retry endpoint. `x-flowwise-signature: t=<ts>;v1=<hex>` is HMAC-SHA256 over
  `t.<body>` with the per-webhook secret.

**Phase 2 notes:**

- **Batches are metadata only.** `batches` stores batch_no/expiry/cost; the
  quantity is always the `stock_ledger` sum (`v_batch_balances`), never a
  stored balance — split deliveries of the same batch just add more movements.
- **FEFO on the till.** A sale line without `batchId` auto-splits across
  batches by earliest expiry (NULLS LAST); explicit `batchId` sells only from
  that batch; uncovered sales are **rejected** (oversell resolution), and a
  refund restores each batch exactly (reversed from the sale's own ledger
  rows, not from client claims).
- **Two-step approvals.** Recording (draft/count) and posting (ledger write)
  are separate permissions (`stock.adjust` vs `stock.adjust.approve`, etc.).
- **Outbox covers inventory.** The outbox dispatches `grn`/`transfer`/
  `adjustment`/`count.post` ops through the same write paths, so an offline
  stock controller's ops reconcile replay-safe on reconnect.

### Phase 4 (hardening & rollout — verified by `bun run test`)

| Endpoint / tool | Permission | Purpose |
| --- | --- | --- |
| `GET /v1/audit[?action&entityType&since&limit]` | `audit.read` | Read-only view of the append-only audit trail (auditors) |
| `bun run load:test` | — | Smoke load test: concurrent till sessions against the sale path, p50/p95/p99 + sales/s, CI-gateable |
| `bun run import:catalogue` | — | Legacy CSV import (catalogue + opening stock) — idempotent, one-transaction, ledger-backed |
| `backend/scripts/backup.sh` / `restore.sh` | — | `pg_dump`/`pg_restore` runbook (see `docs/OPS.md` §2) |

**Phase 4 notes:**

- **Login throttling.** `POST /v1/oauth/authorize` locks an account+IP after
  `AUTH_MAX_FAILED_ATTEMPTS` (default 5) failures within
  `AUTH_ATTEMPT_WINDOW_SECONDS` (default 900s): the endpoint returns 429
  *before* any credential work, so it reveals nothing about whether the
  account exists. A successful login clears the streak. Storage is the
  `auth_attempts` system table (hashed IPs only).
- **Audit trail is now readable** by the auditor role via `GET /v1/audit` —
  previously the `audit.read` permission had no consumer.
- **Data import writes the ledger, never past it.** Opening balances are
  `stock_ledger` rows with `movement_type 'opening'`, written once per
  variant inside a single transaction; re-importing a file is a no-op, and
  corrections go through counts/adjustments like everything else.
- **Restore is a tested discipline** — `docs/OPS.md` documents the nightly
  `pg_dump` backup, the monthly restore drill, the reconciliation check, the
  incident runbook, the one-branch pilot checklist and the role training
  plan (Phase 4 exit criteria).

## Android

`android/` — Kotlin + Jetpack Compose, Room over SQLCipher (encrypted local
store), `outbox_operations` + `sync_cursors`, WorkManager catalogue sync,
ML Kit + CameraX barcode scanning. Open in Android Studio and run
`./gradlew :app:assembleDebug`; set the API base URL via
`buildConfigField` (default `http://10.0.2.2:4000/v1` for the emulator).

Screens: Login → Branch select → Home (Till / Stock / Procurement / Sync
queue). The till takes cash, card and mobile-money tenders with quick
amounts and live change; sales, GRNs, transfers and adjustments are saved to
the local outbox first and pushed via `POST /v1/outbox` by a WorkManager
worker (auto) or the Sync queue screen (manual "Sync now") — same shared
flush path, replay-safe via `client_operation_id`.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Tenancy, RBAC, OAuth+devices, migrations, catalogue sync | ✅ built & tested |
| 1 | POS (tax/tender/receipt), shifts/cash-up, outbox push/pull | ✅ sales, shifts, outbox, reports |
| 2 | GRN, batches/FEFO, counts, adjustments, transfers | ✅ backend + tests — Android UI next |
| 3 | Reorder rules, forecasting, suggestions→POs, partial receipts, scorecard, webhooks | ✅ backend + tests — Android UI next |
| 4 | Load/security/restore/device testing, data import, training, pilot | ✅ backend hardening + runbook (`docs/OPS.md`) — pilot checklists ready |

`stock_ledger` → `apply_stock_ledger()` → `inventory_items` (with
`v_stock_reconciliation`) is already live in migration 003, so Phase 1 builds
sales directly on the invariant machinery rather than reworking it.
