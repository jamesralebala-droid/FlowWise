-- ============================================================================
-- FlowWise — Migration 009: customer accounts, credit sales & eReceipts (Phase 5)
--
-- 1. customers — the debtor master (org-scoped). credit_limit = 0 means "no
--    credit sales"; a credit sale requires a limit and balance headroom.
-- 2. customer_ledger — append-only, the ONLY source of truth for a customer's
--    balance (same discipline as stock_ledger, Invariant 1). A credit sale
--    debits (+), a settlement credits (−), a refund of a credit sale credits
--    (−), a manager adjustment is signed. The balance is a derived view, never
--    a stored column. Writes and their documents commit in one transaction.
-- 3. receipt_emails — persisted attempt log for eReceipts (status
--    pending/sent/failed/skipped) so every send is auditable and a retried
--    upload resolves to one email (UNIQUE org+sale+to).
-- 4. sales.customer_id — optional; when any tender is 'credit' the customer
--    is required and the credit portion becomes a customer_ledger 'sale' row.
-- ============================================================================

CREATE TABLE customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  phone        text,
  email        text,
  credit_limit numeric(14,4) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_org ON customers (org_id);
CREATE UNIQUE INDEX uq_customers_org_email ON customers (org_id, lower(trim(email))) WHERE email IS NOT NULL;

-- Append-only debtor ledger. Positive amount = debt increases (sale), negative
-- = debt decreases (settlement / refund / negative adjustment).
CREATE TABLE customer_ledger (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  branch_id           uuid REFERENCES branches(id),
  entry_type          text NOT NULL
                      CHECK (entry_type IN ('sale', 'refund', 'settlement', 'adjustment')),
  amount              numeric(14,4) NOT NULL CHECK (amount <> 0),
  reference_type      text NOT NULL,
  reference_id        uuid,
  notes               text,
  client_operation_id text,
  business_time       timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid,
  created_by_device_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_ledger_cust ON customer_ledger (org_id, customer_id, business_time);
-- Invariant 4 (replay-safe): one ledger effect per (customer, client op id).
CREATE UNIQUE INDEX uq_customer_ledger_op
  ON customer_ledger (org_id, customer_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL;

-- Derived balance — never stored. security_invoker keeps RLS of the base
-- table for the querying role (PG 15+).
CREATE VIEW v_customer_balances
WITH (security_invoker = true) AS
  SELECT org_id, customer_id,
         COALESCE(SUM(amount), 0::numeric(14,4))::numeric(14,4) AS balance
  FROM customer_ledger
  GROUP BY org_id, customer_id;

-- A sale may belong to a customer account (credit sales create the receivable
-- inside the same transaction as the sale — Invariant 3).
ALTER TABLE sales ADD COLUMN customer_id uuid REFERENCES customers(id);
CREATE INDEX idx_sales_customer ON sales (org_id, customer_id);

-- eReceipt attempt log. One row per (org, sale, recipient) — a re-send is a
-- replay that returns the stored row, never a second email.
CREATE TABLE receipt_emails (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sale_id             uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  to_email            text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error               text,
  provider_message_id text,
  attempted_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sale_id, to_email)
);
CREATE INDEX idx_receipt_emails_org ON receipt_emails (org_id, created_at DESC);

-- ============================================================================
-- RLS: same org_id pattern as every tenant table
-- ============================================================================
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON customers
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE customer_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_ledger_tenant ON customer_ledger
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE receipt_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY receipt_emails_tenant ON receipt_emails
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

-- ============================================================================
-- Permissions + role mappings
-- ============================================================================
INSERT INTO permissions (code, name, description, category) VALUES
  ('customer.read',    'Read customers',     'View customers, balances and statements', 'Sales'),
  ('customer.write',   'Manage customers',   'Create and edit customer accounts', 'Sales'),
  ('customer.settle',  'Settle accounts',    'Record customer payments (settlements)', 'Sales')
ON CONFLICT (code) DO NOTHING;

-- owner: everything — the blanket mapping in 001 is a one-time insert, so
-- newly added permissions must be granted here explicitly.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'owner', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  -- branch_manager
  ('branch_manager', 'customer.read'),
  ('branch_manager', 'customer.write'),
  ('branch_manager', 'customer.settle'),
  -- cashier: creates customers at the till and reads accounts; settlements
  -- are the manager's two-step approval (kept online-first in Phase 5)
  ('cashier', 'customer.read'),
  ('cashier', 'customer.write'),
  -- stock_controller: sees accounts for dispatch / delivery notes
  ('stock_controller', 'customer.read'),
  -- auditor (read-only)
  ('auditor', 'customer.read')
ON CONFLICT DO NOTHING;
