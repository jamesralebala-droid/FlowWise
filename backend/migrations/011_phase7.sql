-- ============================================================================
-- FlowWise — Migration 011: mobile-money payouts, multi-currency, supplier
-- self-service portal (Phase 7).
--
-- 1. mobile_money_payouts — the refund side of a mobile-money payment. When a
--    sale paid by mobile money is refunded, the refund transaction inserts a
--    pending payout referencing the original payment; the provider refund()
--    runs AFTER commit and confirms asynchronously (webhook / status pull) —
--    exactly the same discipline as payments. A refund never blocks on the
--    gateway.
-- 2. Multi-currency. Organisations price in a base currency
--    (organisations.currency_code, BWP by default). Foreign-currency TENDERS
--    convert at the org's published rate (rate_to_base = base units per 1
--    foreign unit). Sale totals, ledgers, shifts and reports stay in BASE
--    currency; the tender row keeps the foreign amount + rate so receipts can
--    show the customer-facing figure.
-- 3. supplier_users — portal logins scoped to ONE supplier entity. Tokens
--    carry kind='supplier' + supplierId; portal endpoints resolve everything
--    through that id, never through user roles.
-- ============================================================================

-- ---- 1. Mobile-money payouts ------------------------------------------------
CREATE TABLE mobile_money_payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES branches(id),
  payment_id         uuid NOT NULL REFERENCES mobile_money_payments(id),
  sale_id            uuid NOT NULL REFERENCES sales(id),
  refund_id          uuid NOT NULL REFERENCES sale_refunds(id),
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
  UNIQUE (org_id, refund_id),                 -- one payout per refund (Invariant 4)
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX idx_mmpayouts_org_branch ON mobile_money_payouts (org_id, branch_id, created_at DESC);
CREATE INDEX idx_mmpayouts_provider_ref ON mobile_money_payouts (org_id, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- Gateway callbacks arrive WITHOUT a tenant session (same rationale as
-- confirm_mobile_money_payment): resolve the payout by provider reference
-- across orgs, as the migration owner.
CREATE FUNCTION confirm_mobile_money_payout(p_reference text, p_status text)
RETURNS TABLE (id uuid, org_id uuid, sale_id uuid, refund_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE mobile_money_payouts
  SET status = CASE WHEN p_status = 'completed' THEN 'confirmed' ELSE 'failed' END,
      provider_status = p_status,
      error = NULL,
      confirmed_at = CASE WHEN p_status = 'completed' THEN now() ELSE confirmed_at END,
      updated_at = now()
  WHERE provider_reference = p_reference
  RETURNING mobile_money_payouts.id, mobile_money_payouts.org_id,
            mobile_money_payouts.sale_id, mobile_money_payouts.refund_id;
END
$$;

-- ---- 2. Multi-currency -------------------------------------------------------
CREATE TABLE currencies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code         char(3) NOT NULL,
  name         text NOT NULL,
  is_base      boolean NOT NULL DEFAULT false,
  rate_to_base numeric(14,8) NOT NULL CHECK (rate_to_base > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
-- At most one base currency per org (its rate is pinned at 1 by the app).
CREATE UNIQUE INDEX uq_currencies_base ON currencies (org_id) WHERE is_base = true;

ALTER TABLE sale_tenders
  ADD COLUMN tender_currency char(3) NOT NULL DEFAULT 'BWP',
  ADD COLUMN fx_rate numeric(14,8) NOT NULL DEFAULT 1,
  ADD COLUMN amount_fx numeric(14,4) NOT NULL DEFAULT 0;

-- ---- 3. Supplier self-service portal -----------------------------------------
CREATE TABLE supplier_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  supplier_id        uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  email              text NOT NULL,
  name               text NOT NULL,
  password_hash      text NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (org_id, supplier_id)
);
CREATE INDEX idx_supplier_users_email ON supplier_users (lower(email));

-- Security-definer so login can run BEFORE any tenant context exists.
CREATE FUNCTION auth_lookup_supplier_by_email(p_email text)
RETURNS TABLE (id uuid, org_id uuid, supplier_id uuid, email text, name text,
               password_hash text, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, supplier_id, email, name, password_hash, is_active
  FROM supplier_users
  WHERE lower(email) = lower(p_email)
  LIMIT 1
$$;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE mobile_money_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY mmpayouts_tenant ON mobile_money_payouts
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY currencies_tenant ON currencies
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE supplier_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_users_tenant ON supplier_users
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());
