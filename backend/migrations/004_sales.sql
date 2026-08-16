-- ============================================================================
-- FlowWise — Migration 004: sales core (Phase 1).
--
-- Invariant 3: the sale document AND its stock_ledger rows commit in ONE
--              transaction (enforced by the write path, tested).
-- Invariant 4: sales carry client_operation_id, unique per org (partial
--              unique index) — a retried upload resolves to the same sale.
-- Invariant 5: a completed sale is immutable — statement-level trigger
--              rejects UPDATE/DELETE for every role; corrections are new
--              refund/void documents.
-- ============================================================================

CREATE TYPE sale_status AS ENUM ('open', 'completed', 'voided', 'refunded');
CREATE TYPE tender_type AS ENUM ('cash', 'card', 'mobile_money', 'credit', 'other');

CREATE TABLE sales (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  device_id           uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_operation_id text NOT NULL,                     -- Invariant 4
  status              sale_status NOT NULL DEFAULT 'open',
  subtotal            numeric(14,4) NOT NULL CHECK (subtotal >= 0),
  discount            numeric(14,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax_total           numeric(14,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total               numeric(14,4) NOT NULL CHECK (total >= 0),
  tendered            numeric(14,4) NOT NULL DEFAULT 0 CHECK (tendered >= 0),
  change_due          numeric(14,4) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  -- business time is SERVER-assigned, never trusted from the client
  business_time       timestamptz NOT NULL DEFAULT now(),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (org_id, client_operation_id)
);
CREATE INDEX idx_sales_branch_time ON sales (org_id, branch_id, business_time DESC);
CREATE INDEX idx_sales_user_time   ON sales (org_id, user_id, business_time DESC);

-- Lines snapshot the price AND tax rate at completion; historic documents
-- never reprice (definition of done).
CREATE TABLE sale_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sale_id     uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  -- receipt/scan order from the client; preserved in API responses
  line_no     int  NOT NULL CHECK (line_no > 0),
  quantity    numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(14,4) NOT NULL CHECK (unit_price >= 0),   -- server-resolved
  tax_rate    numeric(6,4)  NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 1),  -- snapshot
  tax_amount  numeric(14,4) NOT NULL DEFAULT 0,
  line_total  numeric(14,4) NOT NULL,
  UNIQUE (org_id, sale_id, variant_id),
  UNIQUE (org_id, sale_id, line_no)
);
CREATE INDEX idx_sale_lines_sale ON sale_lines (org_id, sale_id);

CREATE TABLE sale_tenders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sale_id     uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  tender_type tender_type NOT NULL,
  amount      numeric(14,4) NOT NULL CHECK (amount > 0),
  reference   text
);
CREATE INDEX idx_sale_tenders_sale ON sale_tenders (org_id, sale_id);

-- A refund is a NEW document plus reverse ledger movements (Invariant 5);
-- the original sale row never changes.
CREATE TABLE sale_refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sale_id             uuid NOT NULL REFERENCES sales(id),
  user_id             uuid NOT NULL REFERENCES users(id),
  device_id           uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_operation_id text NOT NULL,                     -- Invariant 4
  amount              numeric(14,4) NOT NULL CHECK (amount > 0),
  reason              text,
  business_time       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_operation_id)
);
CREATE INDEX idx_sale_refunds_sale ON sale_refunds (org_id, sale_id);

-- ---- Invariant 5: a completed sale is immutable ----------------------------
-- Statement-level for the same reason as the ledger: RLS with no UPDATE/DELETE
-- policy silently filters rows instead of erroring, so a row-level trigger
-- would never fire for the app role.
CREATE FUNCTION prevent_sale_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales are immutable: % forbidden (use refund/void)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

CREATE TRIGGER trg_sales_no_mutation
  BEFORE UPDATE OR DELETE ON sales
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_sale_mutation();

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_tenant ON sales
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE sale_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_lines_tenant ON sale_lines
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE sale_tenders ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_tenders_tenant ON sale_tenders
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE sale_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY sale_refunds_tenant ON sale_refunds
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());
