# FlowWise

Offline-first, Android-primary sales, stock and reordering for multi-branch
Botswana SMEs — a **BotWise Technologies** product (sister to RunWise). The
till keeps selling with zero network for days; when connectivity returns,
everything reconciles exactly, replay-safe, against a single source of truth.

[![CI](https://github.com/jamesralebala-droid/FlowWise/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesralebala-droid/FlowWise/actions/workflows/ci.yml)

> **Status: Phase 0 (Foundation) ✅ + Phase 1 (POS core) ✅ + Phase 2
> (Inventory ops) ✅ + Phase 3 (Procurement & intelligence) ✅ + Phase 4
> (Hardening & rollout) ✅ + Phase 5 (Customers, credit, reports & eReceipts)
> ✅ + Phase 6 (Mobile money, loyalty & discounts, web reports, receipt
> printing) ✅ + Phase 7 (Mobile-money payouts, multi-currency, POS web
> client, supplier portal, APK artifacts) ✅ + Phase 8 (refunds on the
> Android till, signed release builds, supplier delivery notes → GRNs,
> single-origin hosting) ✅ — implemented & test-verified in this repo.**
> Backend: NestJS + PostgreSQL 15+ (migrations, RLS, OAuth2 PKCE, ledger
> invariants, sales/shifts/outbox/reports, GRN/batches/FEFO/counts/transfers/
> adjustments, reorder rules/suggestions, purchase orders with partial
> receipts, supplier scorecard, webhooks; Phase 4: login throttling, audit
> API, CSV data import, load test, backup/restore runbook; Phase 5:
> customer accounts + credit sales + settlements (append-only ledger),
> stock-valuation/margin/top-products reports, and eReceipts via Resend;
> Phase 6: promotions/discount codes, loyalty points (earn + redeem),
> mobile-money tender (Dodo Payments, webhook-confirmed), a Vite + React
> web reports dashboard (OAuth2 PKCE), and ESC/POS thermal receipt printing
> from the till. Phase 7: mobile-money refunds to wallets (provider
> payouts), multi-currency tenders with per-org FX rates, a full POS web
> client (till in the browser), a supplier self-service portal (POs +
> price list), and APK artifacts from CI. Phase 8: full refund screen on the
> Android till (queue through the outbox), release APKs signed from CI
> keystore secrets, supplier delivery notes that land as draft GRNs the
> branch posts into stock, and the API serving the built web dashboard as
> static files on one origin.
> Android: builds in CI via `gradle :app:assembleDebug` — APK uploaded as an
> artifact; release APK via workflow_dispatch/tags, signed when
> `ANDROID_KEYSTORE_B64` + passwords are set as CI secrets.
> Web: builds in CI via `vite build`; the production API serves `web/dist`
> on the same origin (SPA fallback).

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
                 · 009 customers/credit/eReceipts · 010 promotions/loyalty/
                 mobile money · 011 payouts/currencies/supplier portal
  src/            db layer, OAuth2 PKCE, guards, catalogue, idempotency,
                  sales, shifts, outbox, reports, audit, import, inventory
                  (suppliers, GRNs, transfers, counts, adjustments, stock
                  views), procurement (reorder rules/evaluator, POs,
                  webhooks, scorecard), customers (accounts, ledger,
                  settlements), receipts (eReceipt email via Resend),
                  promotions (discount codes), mobile-money (provider
                  adapters, webhook, payouts), currencies (FX rates),
                  supplier-portal (self-service API)
  test/           PGlite-backed integration tests (RLS, ledger, OAuth,
                  catalogue, sales, shifts, outbox, reports, inventory,
                  FEFO, procurement, import, throttling, customers,
                  receipts, Phase-5 reports, Phase-6 promotions/loyalty/
                  mobile money)
  scripts/        test.sh · loadtest.ts · backup.sh · restore.sh
android/          Kotlin + Jetpack Compose app (Room/SQLCipher, WorkManager,
                  ML Kit, ESC/POS thermal printing)
web/              Vite + React dashboard + POS web client + supplier portal
                  (OAuth2 PKCE, recharts)
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
| `RESEND_API_KEY` | *(unset)* | eReceipts: Resend API key. Without it, email ops record `skipped` and sales never break |
| `RECEIPT_EMAIL_FROM` | `FlowWise <onboarding@resend.dev>` | eReceipt sender address (verify your domain in Resend) |
| `DODO_API_KEY` | *(unset)* | Mobile money: Dodo Payments secret key. Unset → `mock` provider (instantly confirms, demo/sandbox) |
| `DODO_WEBHOOK_SECRET` | *(unset)* | Mobile money: HMAC secret verifying `POST /v1/mobile-money/webhook`. Unset → webhook refuses every callback |
| `SUPPLIER_TOKEN_TTL_SECONDS` | `86400` | Supplier-portal access-token lifetime (24h, re-login on expiry) |
| `WEB_DIST` | *(auto-detected: `web/dist`)* | Absolute path to the built web dashboard; when present the API serves it as static files with an SPA fallback (Phase 8 single-origin hosting) |
| `ANDROID_KEYSTORE_B64` · `ANDROID_KEYSTORE_PASSWORD` · `ANDROID_KEY_ALIAS` · `ANDROID_KEY_PASSWORD` | *(unset)* | CI signing secrets for the release APK (base64 keystore + credentials). Unset → release builds stay unsigned (side-load friendly) |

**Web dashboard:** `web/` is a Vite + React app (`bun --cwd web dev` for the
dev server, default `http://localhost:5173`). It signs in through the same
OAuth2 PKCE endpoint and reads the reports APIs; point it at the API with
`VITE_API_BASE_URL` (default `http://localhost:4000/v1`). The build emits
static files to `web/dist/` (CI: `vite build`).

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

### Phase 5 (customers, credit, reports & eReceipts — verified by `bun run test`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /v1/customers[?q]` · `POST /v1/customers` | `customer.read` / `customer.write` | List (balances derived from the ledger) / create account (`creditLimit` "0" = no credit) |
| `GET /v1/customers/:id` · `PUT /:id` | `customer.read` / `customer.write` | Detail / edit (email unique per org) |
| `GET /v1/customers/:id/statement[?from&to]` | `customer.read` | Every ledger entry with branch name, newest first |
| `POST /v1/customers/:id/settlements` | `customer.settle` | Record a payment — ledger entry, replay-safe on `client_operation_id` (outbox `customer.settle` op) |
| `POST /v1/sales` (with `customerId` + `credit` tender) | `pos.sell` | Credit sale: receivable created **in the same transaction** as the sale (Invariant 3); limit + balance checked |
| `POST /v1/receipts/email` | `pos.sell` | eReceipt by the sale's `clientOperationId` (outbox `receipt.email` op) |
| `GET /v1/reports/stock-valuation` | `reports.read` | On-hand × latest landed cost per branch |
| `GET /v1/reports/margin` | `reports.read` | Revenue vs COGS per variant (current-cost approximation) |
| `GET /v1/reports/top-products[?limit]` | `reports.read` | Top products by revenue over the period |

**Phase 5 notes:**

- **The receivable is a ledger, not a column.** `customer_ledger` is
  append-only (sale +, settlement/refund −); the balance is the derived
  `v_customer_balances` view, same discipline as stock. A credit sale and its
  receivable row commit in one transaction; a refund of a credit sale
  reduces the receivable in the refund's transaction.
- **Credit limits are enforced at sale time** — a customer with
  `credit_limit = 0` is a cash/card-only account, and over-limit sales are
  rejected before any ledger write.
- **Two-step approval on settlements.** Cashiers can create customers at the
  till (`customer.write`) but only managers/owners record payments
  (`customer.settle`) — and settlements queue through the outbox like every
  other offline write.
- **eReceipts are replay-safe and never block the till.** One email per
  (sale, recipient), persisted in `receipt_emails`; a retried flush returns
  the stored attempt. Without a `RESEND_API_KEY` the attempt is recorded as
  `skipped` and the sale still completes — offline-first means nothing
  breaks because email is down.

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

### Phase 6 (mobile money, loyalty & discounts, web dashboard, receipt printing — verified by `bun run test`)

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /v1/promotions[?activeOnly]` · `POST /v1/promotions` · `PUT /:id` | `promotion.manage` | Discount codes: percentage or amount, min-spend, usage limit, start/end window, active toggle. `usageLimit` counts redemptions server-side |
| `POST /v1/sales` (with `promotionCode`) | `pos.sell` | Promotion applied + **usage counter incremented in the same transaction** as the sale; unknown/expired/over-limit codes rejected before any ledger write |
| `POST /v1/sales` (with `customerId` + `loyaltyRedeem.points`) | `pos.sell` | Redeem points against the total (`loyalty_redeem_bwp_per_point`, capped at the payable); insufficient points rejected before any ledger write |
| `GET /v1/mobile-money/payments[?branchId&status&since&limit]` | `payment.read` | Payment statuses for the till/back-office pull (the other half of async reconcile) |
| `POST /v1/mobile-money/webhook` | *(public)* | Provider callback. HMAC-SHA256 verified against `DODO_WEBHOOK_SECRET` over the raw body; confirms/fails the payment by provider reference across orgs (SECURITY DEFINER) |

**Phase 6 notes:**

- **Loyalty is a ledger, not a balance.** `loyalty_transactions` is
  append-only (earn on paid sales with a customer, redeem on request, exact
  reversal on refund); `v_customer_loyalty` derives the balance. Earn/redeem
  rows write inside the sale transaction with `client_operation_id`-scoped
  idempotency keys, so an offline till can never double-earn on a retry.
  Rates are per-org: `loyalty_earn_points_per_bwp` (default 0.1, i.e. 1
  point per P10) and `loyalty_redeem_bwp_per_point` (default P0.10 per
  point).
- **Promotions are server-validated.** The till sends the code; the service
  checks active/window/min-spend/usage-limit and bumps `times_used` in the
  sale transaction — a replayed sale cannot burn the cap twice.
- **Mobile money is async and never blocks the till.** A mobile-money
  tender inserts a `pending` `mobile_money_payments` row *inside* the sale
  transaction; the provider initiate runs after commit (a failure marks the
  row `failed`, the sale stands); confirmation arrives via the signed
  webhook or the status pull. Provider is pluggable: `mock` (default,
  instantly confirms — sandbox/demo) or `dodo` behind `DODO_API_KEY`.
- **Refunds reverse everything.** A refund of a Phase-6 sale reverses the
  promotion usage count, the exact loyalty earn/redeem rows, and any
  mobile-money payment row — in the refund's transaction.
- **Reports surface it.** `sales-summary` adds `discountTotal`, loyalty
  earn/redeem and mobile-money confirmed/pending totals; `margin` and
  `top-products` keep working unchanged.

### Phase 7 (mobile-money payouts, multi-currency, POS web client, supplier portal — verified by `bun run test`)

| Endpoint | Permission / principal | Purpose |
| --- | --- | --- |
| `POST /v1/sales/:id/refund` (mobile-money sale) | `pos.refund` | Refund **pays the customer back to their wallet**: the refund transaction inserts a `pending` payout referencing the original payment; the provider `refund()` runs after commit (a failure marks the payout `failed`, the refund stands); confirmation arrives via the signed webhook or the status pull |
| `GET /v1/mobile-money/payouts[?branchId&status]` | `payment.read` | Payout (refund-to-wallet) statuses for till/back-office pulls |
| `GET /v1/currencies` | `catalogue.read` | Org currency list incl. base (rate 1) |
| `POST /v1/currencies` · `PUT /:code` | `settings.manage` | Add a currency / update its `rateToBase` (base pinned at 1; duplicates rejected) |
| `POST /v1/sales` (tender with `currency`) | `pos.sell` | Foreign-currency cash/card tenders convert at the day's rate; totals, ledgers, shifts and reports stay in base currency; `sale_tenders` keeps `amountFx` + `fxRate` for receipts |
| `POST /v1/supplier-portal/login` | *(public)* | Supplier credentials → short-lived `kind=supplier` token scoped to ONE supplier entity (same brute-force throttle as staff login) |
| `GET /v1/supplier-portal/me` · `PUT /me` | supplier | Profile + contact info (supplier's own record) |
| `GET /v1/supplier-portal/purchase-orders[/:id]` | supplier | Their POs (sent onward) with lines, received and outstanding quantities |
| `GET /v1/supplier-portal/price-list` · `PUT /price-list/:variantId` | supplier | Suppliers maintain their own cost hints (feed margins/POs), audited as `supplier.price_update` |

**Phase 7 notes:**

- **Payouts are ledger-safe.** A refund creates the payout row in the same
  transaction as the refund document (Invariant 3) with a
  `client_operation_id`-scoped idempotency key (one payout per refund, replay
  returns the stored refund). Provider refunds run after commit — the gateway
  can never block a refund that already happened on the ledger.
- **Multi-currency is tender-level.** Products stay priced in the org's base
  currency; only cash/card/other tenders may be in a foreign currency
  (mobile money and credit are base-only — the gateway and the receivable
  ledger both need a single currency). Rates are per-org, edited by owners,
  and stored on each tender row so historic receipts never reprice.
- **The supplier portal is a separate principal.** Supplier tokens carry
  `kind=supplier` + `supplierId`; every portal query is scoped by that id in
  the org's tenant context (RLS still enforced). Staff tokens cannot call
  portal endpoints and vice versa.
- **CI ships APKs.** Every CI run uploads `app-debug.apk` as an artifact
  (14-day retention) so the till team can side-load without a dev box; a
  `workflow_dispatch` or `v*` tag push builds a minified release APK
  (30-day artifact).

### Phase 8 (till refunds, signed releases, supplier delivery notes, single-origin hosting — verified by `bun run test`)

| Endpoint | Permission / principal | Purpose |
| --- | --- | --- |
| `POST /v1/supplier-portal/delivery-notes` | supplier | **Delivery-note submission**: creates a DRAFT GRN tied to the PO with unit costs snapshotted from the PO (never client-supplied). Idempotent per (PO, lines) — retrying the same drop returns the same draft; over-delivery beyond the outstanding quantity (posted + pending) is rejected, and only the PO's own supplier can submit. The branch reviews the draft and posts it with the normal `POST /v1/grns/:id/post` |
| `POST /v1/grns/:id/post` (delivery-note GRN) | `stock.grn` | **Batch approval**: posting one delivery-note GRN posts every pending delivery-note GRN for that PO in the same transaction — stock and PO received-quantity move together (Invariant 3), the PO advances to `received` when the declared batch completes it |

**Phase 8 notes:**

- **Refunds are now on the Android till.** A refund screen (Home → Refunds)
  lists recent sales, lets the cashier pick one, enter the refund amount +
  reason, and queues a `refund` op in the local outbox — it syncs with the
  same replay-safe path as every other offline write, and refunds of
  mobile-money sales pay the customer back to their wallet (Phase 7).
- **Release signing is secret-driven.** `android/app/build.gradle.kts` reads
  `android/keystore.properties` (local, gitignored) or CI secrets
  (`ANDROID_KEYSTORE_B64` + passwords/alias). No keystore configured → the
  release build stays unsigned; CI decodes the base64 keystore to a temp
  file only when the secret is set.
- **Delivery notes flow into GRNs, not straight to stock.** The supplier's
  declaration becomes a *draft* GRN the branch can inspect and post; until
  posted there is no ledger effect. Posting one delivery-note GRN approves
  the whole declared batch for that PO, so partial drops can't be approved
  out of order and the PO can never be over-received.
- **One origin in production.** The NestJS API serves the built `web/dist`
  (dashboard + POS + supplier portal) as static files with an SPA fallback
  for client routes; `/v1/*` is never intercepted. `bun run build` at the
  root builds backend + web, and `bun run start` boots the API which serves
  both — no separate static host or CORS config needed.

## Android

`android/` — Kotlin + Jetpack Compose, Room over SQLCipher (encrypted local
store), `outbox_operations` + `sync_cursors`, WorkManager catalogue sync,
ML Kit + CameraX barcode scanning, and an ESC/POS thermal printer driver
(Bluetooth). Open in Android Studio and run `./gradlew :app:assembleDebug`;
set the API base URL via `buildConfigField` (default
`http://10.0.2.2:4000/v1` for the emulator).

Screens: Login → Branch select → Home (Till / Stock / Procurement /
Customers / Reports / Sync queue). The till takes cash, card, mobile-money
**and credit** tenders with quick amounts and live change — a credit tender
requires picking a customer account (balance shown inline), a mobile-money
tender requires the customer's phone number (payment reconciles
asynchronously), and you can queue an **eReceipt** by entering the
customer's email before completing. Phase 6 adds a **promo-code field** and
**loyalty redemption** (points shown for the selected customer, capped at
what they hold) to the till, and the receipt screen prints to a bonded
Bluetooth thermal printer (ESC/POS, 58 mm, permission-aware), and a
**Refunds** screen queues `refund` ops through the same outbox — pick a sale,
enter the amount + reason, and it syncs replay-safe (mobile-money refunds
pay back to the customer's wallet). Sales, GRNs,
transfers, adjustments, **settlements** and **receipt emails** are saved to
the local outbox first and pushed via `POST /v1/outbox` by a WorkManager
worker (auto) or the Sync queue screen (manual "Sync now") — same shared
flush path, replay-safe via `client_operation_id`. Customers gives account
balances, creation, statements and offline-queued payments; Reports shows
the sales summary + tender mix, stock valuation and top products for
Today / 7 days / 30 days. APKs: every CI run uploads the debug APK as an
artifact; run the **Android release APK** job (or push a `v*` tag) for the
minified release build.

## Web dashboard & POS

`web/` — a Vite + React app for managers, cashiers and suppliers, signed in
with the same OAuth2 PKCE flow as the app (no redirect — the backend's
native-client JSON endpoints exchange directly), tokens in `sessionStorage`
with refresh-and-retry. Pages:

- **Dashboard** (period KPIs, tender-mix pie, top products, loyalty + latest
  mobile-money payments), **Reports** (sales summary, daily buckets, stock
  valuation, margin), **Customers** (searchable balances/limits/points +
  statement viewer), **Payments** (mobile-money payments AND payouts with
  status filters) and **Promotions** (create/edit discount codes).
- **Open till** (`/pos`, Phase 7) — a full browser till: searchable product
  grid, cart with quantity controls, cash/card/mobile-money/credit tenders
  with foreign-currency support (cash/card in ZAR/USD convert at the day's
  rate), customer picker with loyalty points, promo codes, shift
  open/close, receipt view + print, and refunds that pay mobile-money
  customers back to their wallet. Sales are server-priced and replay-safe
  (`client_operation_id`); the browser is assumed online.
- **Supplier portal** (`/supplier`, Phase 7) — a separate login for supplier
  accounts (`<code>@flowwise.demo` / `Password123!` in the demo seed).
  Suppliers see their purchase orders with received/outstanding quantities
  and maintain their own price list (cost hints) and contact details.

```bash
bun --cwd web install
bun --cwd web dev        # http://localhost:5173 (proxy to the API via CORS)
VITE_API_BASE_URL=https://api.example.com/v1 bun --cwd web build
```

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Tenancy, RBAC, OAuth+devices, migrations, catalogue sync | ✅ built & tested |
| 1 | POS (tax/tender/receipt), shifts/cash-up, outbox push/pull | ✅ sales, shifts, outbox, reports |
| 2 | GRN, batches/FEFO, counts, adjustments, transfers | ✅ backend + tests — Android UI next |
| 3 | Reorder rules, forecasting, suggestions→POs, partial receipts, scorecard, webhooks | ✅ backend + tests — Android UI next |
| 4 | Load/security/restore/device testing, data import, training, pilot | ✅ backend hardening + runbook (`docs/OPS.md`) — pilot checklists ready |
| 5 | Customer accounts & credit sales, reports & analytics, eReceipts, Android build in CI | ✅ backend + Android + CI (`gradle :app:assembleDebug`) |
| 6 | Mobile-money tender, loyalty & discounts, web reports dashboard, receipt printing | ✅ backend + Android + web + CI (3 jobs) |
| 7 | Mobile-money payouts, refunds-to-wallet, multi-currency tenders, POS web client, supplier portal, APK artifacts | ✅ backend + web + CI (4 jobs) |
| 8 | Till refunds (Android outbox), signed release builds, supplier delivery notes → GRNs, single-origin hosting | ✅ backend + Android + web + CI (Phase 8) |

`stock_ledger` → `apply_stock_ledger()` → `inventory_items` (with
`v_stock_reconciliation`) is already live in migration 003, so Phase 1 builds
sales directly on the invariant machinery rather than reworking it.
