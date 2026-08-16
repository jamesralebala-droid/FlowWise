-- ============================================================================
-- FlowWise — Migration 006: inventory operations (Phase 2).
--
-- Supplier mappings, GRNs, batches/FEFO, stock transfers, counts and
-- adjustments. Every document follows the Phase 1 pattern:
--   * Invariant 3 — the document AND its stock_ledger rows commit in ONE
--     transaction (write paths, tested).
--   * Invariant 4 — documents carry client_operation_id (unique per org) and
--     every movement carries an idempotency_key; replay resolves to the same
--     document with zero side effects.
--   * Posted documents are immutable — corrections are NEW documents
--     (statement-level trigger, same rationale as sales/shifts).
--   * Batches are METADATA ONLY: batch quantity is derived from stock_ledger
--     (v_batch_balances), never stored — balances stay reproducible from the
--     ledger alone (Invariant 1/2).
-- ============================================================================

-- ---- Suppliers --------------------------------------------------------------
CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                text NOT NULL,
  code                text NOT NULL,
  contact_name        text,
  contact_phone       text,
  email               text,
  payment_terms       text,
  is_active           boolean NOT NULL DEFAULT true,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX idx_suppliers_org_name ON suppliers (org_id, name);

-- Supplier ↔ variant mappings ("supplier mappings"): the cost basis hint and
-- the supplier's own SKU for GRN line entry.
CREATE TABLE supplier_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  supplier_id   uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  supplier_sku  text,
  unit_cost     numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, supplier_id, variant_id)
);
CREATE INDEX idx_supplier_products_supplier ON supplier_products (org_id, supplier_id);

-- ---- Goods receipt notes ----------------------------------------------------
CREATE TYPE grn_status AS ENUM ('draft', 'posted');

CREATE TABLE goods_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  supplier_id         uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  document_no         text NOT NULL,
  status              grn_status NOT NULL DEFAULT 'draft',
  client_operation_id text NOT NULL,                    -- Invariant 4
  received_at         timestamptz NOT NULL DEFAULT now(), -- server-assigned
  notes               text,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_operation_id),
  UNIQUE (org_id, document_no)
);
CREATE INDEX idx_grns_branch_time ON goods_receipts (org_id, branch_id, received_at DESC);

CREATE TABLE goods_receipt_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  goods_receipt_id  uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  line_no           int  NOT NULL CHECK (line_no > 0),
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  quantity          numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost         numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  batch_no          text,
  expiry_date       date,
  UNIQUE (org_id, goods_receipt_id, line_no),
  UNIQUE (org_id, goods_receipt_id, variant_id)
);
CREATE INDEX idx_grn_lines_grn ON goods_receipt_lines (org_id, goods_receipt_id);

-- ---- Batches (metadata only; balance derived from the ledger) ---------------
CREATE TABLE batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  batch_no      text NOT NULL,
  expiry_date   date,
  unit_cost     numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  source_grn_id uuid REFERENCES goods_receipts(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Split deliveries of the same batch re-use the row; quantity is the
  -- ledger sum, so multiple GRNs simply add more movements to one batch.
  UNIQUE (org_id, branch_id, variant_id, batch_no)
);
CREATE INDEX idx_batches_fefo ON batches (org_id, branch_id, variant_id, expiry_date, created_at);

-- ---- Ledger + sale lines become batch-aware ---------------------------------
ALTER TABLE stock_ledger ADD COLUMN batch_id uuid REFERENCES batches(id);
CREATE INDEX idx_ledger_batch ON stock_ledger (org_id, batch_id);
ALTER TABLE sale_lines ADD COLUMN batch_id uuid REFERENCES batches(id);

-- A document may only reference a batch of ITS OWN org. FK checks bypass RLS,
-- so enforce with a trigger (runs as the invoker → RLS hides cross-org rows).
CREATE FUNCTION assert_batch_in_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM batches b WHERE b.id = NEW.batch_id AND b.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'batch does not belong to this organisation'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_ledger_batch_org
  BEFORE INSERT OR UPDATE OF batch_id ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION assert_batch_in_org();
CREATE TRIGGER trg_sale_lines_batch_org
  BEFORE INSERT OR UPDATE OF batch_id ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION assert_batch_in_org();

-- ---- Stock transfers --------------------------------------------------------
CREATE TYPE transfer_status AS ENUM ('draft', 'posted');

CREATE TABLE stock_transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  from_branch_id      uuid NOT NULL REFERENCES branches(id),
  to_branch_id        uuid NOT NULL REFERENCES branches(id),
  document_no         text NOT NULL,
  status              transfer_status NOT NULL DEFAULT 'draft',
  client_operation_id text NOT NULL,                    -- Invariant 4
  notes               text,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_operation_id),
  UNIQUE (org_id, document_no),
  CHECK (from_branch_id <> to_branch_id)
);
CREATE INDEX idx_transfers_from ON stock_transfers (org_id, from_branch_id, created_at DESC);
CREATE INDEX idx_transfers_to   ON stock_transfers (org_id, to_branch_id, created_at DESC);

CREATE TABLE stock_transfer_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  line_no     int  NOT NULL CHECK (line_no > 0),
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  quantity    numeric(14,4) NOT NULL CHECK (quantity > 0),
  batch_id    uuid REFERENCES batches(id),
  UNIQUE (org_id, transfer_id, line_no),
  UNIQUE (org_id, transfer_id, variant_id)
);
CREATE INDEX idx_transfer_lines_transfer ON stock_transfer_lines (org_id, transfer_id);
CREATE TRIGGER trg_transfer_lines_batch_org
  BEFORE INSERT OR UPDATE OF batch_id ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION assert_batch_in_org();

-- ---- Stock counts (blind counts with server-computed variance) --------------
CREATE TYPE count_status AS ENUM ('open', 'counted', 'posted');

CREATE TABLE stock_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  document_no         text NOT NULL,
  status              count_status NOT NULL DEFAULT 'open',
  client_operation_id text NOT NULL,                    -- Invariant 4
  notes               text,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_operation_id),
  UNIQUE (org_id, document_no)
);
-- One live count per branch at a time; closed (posted) counts do not block.
CREATE UNIQUE INDEX uq_counts_one_active_per_branch
  ON stock_counts (org_id, branch_id) WHERE status IN ('open', 'counted');
CREATE INDEX idx_counts_branch_time ON stock_counts (org_id, branch_id, created_at DESC);

-- counted_quantity is NULL until the counter records the blind count.
-- expected_quantity + variance are SNAPSHOTTED at post time (traceable).
CREATE TABLE stock_count_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  count_id           uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  line_no            int  NOT NULL CHECK (line_no > 0),
  variant_id         uuid NOT NULL REFERENCES product_variants(id),
  counted_quantity   numeric(14,4) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  expected_quantity  numeric(14,4),
  variance           numeric(14,4),
  UNIQUE (org_id, count_id, line_no),
  UNIQUE (org_id, count_id, variant_id)
);
CREATE INDEX idx_count_lines_count ON stock_count_lines (org_id, count_id);

-- ---- Stock adjustments ------------------------------------------------------
CREATE TYPE adjustment_status AS ENUM ('draft', 'posted');

CREATE TABLE stock_adjustments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  document_no         text NOT NULL,
  status              adjustment_status NOT NULL DEFAULT 'draft',
  adjustment_type     text NOT NULL CHECK (adjustment_type IN ('increase', 'decrease')),
  reason              text NOT NULL,
  client_operation_id text NOT NULL,                    -- Invariant 4
  notes               text,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_operation_id),
  UNIQUE (org_id, document_no)
);
CREATE INDEX idx_adjustments_branch_time ON stock_adjustments (org_id, branch_id, created_at DESC);

CREATE TABLE stock_adjustment_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  adjustment_id uuid NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  line_no       int  NOT NULL CHECK (line_no > 0),
  variant_id    uuid NOT NULL REFERENCES product_variants(id),
  quantity      numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost     numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  batch_id      uuid REFERENCES batches(id),
  UNIQUE (org_id, adjustment_id, line_no),
  UNIQUE (org_id, adjustment_id, variant_id)
);
CREATE INDEX idx_adjustment_lines_adjustment ON stock_adjustment_lines (org_id, adjustment_id);
CREATE TRIGGER trg_adjustment_lines_batch_org
  BEFORE INSERT OR UPDATE OF batch_id ON stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION assert_batch_in_org();

-- ---- Low-stock alert thresholds (Phase 2) -----------------------------------
ALTER TABLE product_variants
  ADD COLUMN reorder_level    numeric(14,4) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  ADD COLUMN reorder_quantity numeric(14,4) NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0);

-- ---- Posted documents are immutable ----------------------------------------
-- The ONLY allowed UPDATE is the draft→posted transition; anything else on a
-- posted row (or any DELETE) raises. ROW-level here (unlike the ledger/sales
-- statement triggers): these tables have FULL RLS policies, so visible rows
-- always reach the trigger, and the guard needs OLD.status — which is NULL in
-- a statement-level trigger. Cross-org rows are blocked by RLS itself.
CREATE FUNCTION protect_posted_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted documents are immutable: % forbidden (post a correction instead)', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_grns_protect        BEFORE UPDATE OR DELETE ON goods_receipts   FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER trg_transfers_protect   BEFORE UPDATE OR DELETE ON stock_transfers  FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER trg_counts_protect      BEFORE UPDATE OR DELETE ON stock_counts     FOR EACH ROW EXECUTE FUNCTION protect_posted_document();
CREATE TRIGGER trg_adjustments_protect BEFORE UPDATE OR DELETE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION protect_posted_document();

-- ---- Derived view: batch balances from the ledger (never stored) ------------
CREATE VIEW v_batch_balances
WITH (security_invoker = true) AS
SELECT b.id AS batch_id, b.org_id, b.branch_id, b.variant_id, b.batch_no,
       b.expiry_date, b.unit_cost, b.created_at,
       COALESCE(SUM(sl.quantity), 0)::numeric(14,4) AS quantity_on_hand
FROM batches b
LEFT JOIN stock_ledger sl ON sl.batch_id = b.id
GROUP BY b.id;

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY suppliers_tenant ON suppliers
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE supplier_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_products_tenant ON supplier_products
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY batches_tenant ON batches
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY grns_tenant ON goods_receipts
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grn_lines_tenant ON goods_receipt_lines
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY transfers_tenant ON stock_transfers
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY transfer_lines_tenant ON stock_transfer_lines
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY counts_tenant ON stock_counts
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY count_lines_tenant ON stock_count_lines
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY adjustments_tenant ON stock_adjustments
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE stock_adjustment_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY adjustment_lines_tenant ON stock_adjustment_lines
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

-- ---- Permissions ------------------------------------------------------------
-- Two-step workflows: recording (count/adjust) is one permission, posting the
-- document to the ledger (which actually moves stock) is a separate approval.
INSERT INTO permissions (code, name, description, category) VALUES
  ('stock.count.approve',   'Approve stock counts',   'Post a counted stock-take to the ledger', 'Stock'),
  ('stock.adjust.approve',  'Approve adjustments',    'Post a stock adjustment to the ledger', 'Stock')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('owner',            'stock.count.approve'),
  ('owner',            'stock.adjust.approve'),
  ('branch_manager',   'stock.count.approve'),
  ('branch_manager',   'stock.adjust.approve'),
  ('stock_controller', 'stock.count.approve'),
  ('stock_controller', 'stock.adjust.approve')
ON CONFLICT DO NOTHING;
