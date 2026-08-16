-- ============================================================================
-- FlowWise — Migration 010: promotions, loyalty & mobile money (Phase 6)
--
-- 1. promotions — org-scoped discount campaigns. A sale references one by
--    code; resolution (validation + discount amount) happens inside the sale
--    transaction so usage counters can never diverge from the documents.
-- 2. loyalty_transactions — append-only points log per customer (same
--    discipline as stock_ledger / customer_ledger: the balance is a derived
--    view, never a stored column). Sales earn, sales redeem, refunds reverse
--    the exact rows the sale created.
-- 3. mobile_money_payments — one row per (org, sale) when a sale tenders
--    mobile money. Status pending → confirmed/failed is driven by the
--    provider adapter (mock auto-confirms; Dodo confirms via webhook). The
--    till never blocks on the gateway — the sale completes, the payment
--    reconciles.
-- 4. sales gains promotion_id / loyalty_points_used / loyalty_credit.
-- 5. organisations gains the loyalty earn/redeem rates (per-org settings).
-- ============================================================================

-- ---- promotions ------------------------------------------------------------
CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  discount_type   text NOT NULL CHECK (discount_type IN ('percentage', 'amount')),
  discount_value  numeric(14,4) NOT NULL CHECK (discount_value > 0),
  min_spend       numeric(14,4) NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  usage_limit     int CHECK (usage_limit IS NULL OR usage_limit > 0),
  times_used      int NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  is_active       boolean NOT NULL DEFAULT true,
  starts_at       timestamptz,
  ends_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Code uniqueness is case-insensitive (expressions need an index, not a
-- table-level UNIQUE constraint).
CREATE UNIQUE INDEX uq_promotions_org_code ON promotions (org_id, lower(code));
CREATE INDEX idx_promotions_org ON promotions (org_id, is_active);

-- ---- loyalty ----------------------------------------------------------------
-- Points are integers. Positive = earned, negative = redeemed/reversed.
CREATE TABLE loyalty_transactions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  customer_id          uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id              uuid REFERENCES sales(id) ON DELETE SET NULL,
  entry_type           text NOT NULL
                       CHECK (entry_type IN ('earn', 'redeem', 'refund_reverse')),
  points               int NOT NULL CHECK (points <> 0),
  reference_type       text NOT NULL,
  reference_id         uuid,
  notes                text,
  client_operation_id  text NOT NULL,
  business_time        timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid,
  created_by_device_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions (org_id, customer_id, business_time);
-- Invariant 4 (replay-safe): a retried write can never double-earn/double-spend.
CREATE UNIQUE INDEX uq_loyalty_op ON loyalty_transactions (org_id, client_operation_id);

-- Derived balance — never stored (same discipline as v_customer_balances).
CREATE VIEW v_customer_loyalty
WITH (security_invoker = true) AS
  SELECT org_id, customer_id,
         COALESCE(SUM(points), 0)::int AS points
  FROM loyalty_transactions
  GROUP BY org_id, customer_id;

-- ---- mobile money ------------------------------------------------------------
CREATE TABLE mobile_money_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES branches(id),
  sale_id            uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  phone              text NOT NULL,
  amount             numeric(14,4) NOT NULL CHECK (amount > 0),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'failed')),
  provider_reference text,
  provider_status    text,
  error              text,
  idempotency_key    text NOT NULL,
  confirmed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sale_id),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX idx_mmp_org_branch ON mobile_money_payments (org_id, branch_id, created_at DESC);
CREATE INDEX idx_mmp_provider_ref ON mobile_money_payments (org_id, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- ---- sales / organisations extensions ----------------------------------------
ALTER TABLE sales ADD COLUMN promotion_id uuid REFERENCES promotions(id) ON DELETE SET NULL;
ALTER TABLE sales ADD COLUMN loyalty_points_used int NOT NULL DEFAULT 0 CHECK (loyalty_points_used >= 0);
ALTER TABLE sales ADD COLUMN loyalty_credit numeric(14,4) NOT NULL DEFAULT 0 CHECK (loyalty_credit >= 0);
CREATE INDEX idx_sales_promotion ON sales (org_id, promotion_id);

ALTER TABLE organisations ADD COLUMN loyalty_earn_points_per_bwp numeric(14,4) NOT NULL DEFAULT 0.1
  CHECK (loyalty_earn_points_per_bwp >= 0);
ALTER TABLE organisations ADD COLUMN loyalty_redeem_bwp_per_point numeric(14,4) NOT NULL DEFAULT 0.10
  CHECK (loyalty_redeem_bwp_per_point >= 0);

-- ============================================================================
-- Gateway callbacks arrive WITHOUT a tenant session (no bearer token). The
-- payment row is confirmed by provider_reference across orgs via a SECURITY
-- DEFINER function (owned by the migrator, like apply_stock_ledger); the app
-- then writes the audit row inside the resolved org's tenant context.
CREATE FUNCTION confirm_mobile_money_payment(p_reference text, p_status text)
RETURNS TABLE (id uuid, org_id uuid, sale_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE mobile_money_payments
  SET status = CASE WHEN p_status = 'completed' THEN 'confirmed' ELSE 'failed' END,
      provider_status = p_status,
      error = NULL,
      confirmed_at = CASE WHEN p_status = 'completed' THEN now() ELSE confirmed_at END,
      updated_at = now()
  WHERE provider_reference = p_reference
  RETURNING mobile_money_payments.id, mobile_money_payments.org_id, mobile_money_payments.sale_id;
END
$$;

-- ============================================================================
-- RLS: same org_id pattern as every tenant table
-- ============================================================================
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
CREATE POLICY promotions_tenant ON promotions
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY loyalty_tenant ON loyalty_transactions
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE mobile_money_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY mmp_tenant ON mobile_money_payments
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

-- ============================================================================
-- Permissions + role mappings
-- ============================================================================
INSERT INTO permissions (code, name, description, category) VALUES
  ('promotion.manage', 'Manage promotions', 'Create and edit discount promotions', 'Sales'),
  ('payment.read',     'Read payments',     'View mobile-money payment statuses', 'Sales')
ON CONFLICT (code) DO NOTHING;

-- owner: everything — the blanket mapping in 001 is a one-time insert, so
-- newly added permissions must be granted here explicitly.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'owner', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  -- branch_manager
  ('branch_manager', 'promotion.manage'),
  ('branch_manager', 'payment.read'),
  -- cashier: sees payment status at the till (the gateway is async)
  ('cashier', 'payment.read'),
  -- auditor (read-only)
  ('auditor', 'payment.read')
ON CONFLICT DO NOTHING;
