-- ============================================================================
-- FlowWise — Migration 003: stock_ledger (source of truth), inventory_items
-- (derived cache), enforce-the-invariants triggers, reconciliation views.
--
-- Invariant 1: stock_ledger is append-only — enforced by a trigger.
-- Invariant 2: inventory_items is NEVER written by clients — maintained only
--              by apply_stock_ledger() (SECURITY DEFINER, owner context).
-- Invariant 3: documents + ledger entries commit in one transaction (app).
-- Invariant 4: every movement carries a per-org unique idempotency_key.
-- ============================================================================

CREATE TYPE movement_type AS ENUM (
  'sale', 'sale_refund', 'grn', 'grn_correction', 'adjustment',
  'count_adjustment', 'transfer_out', 'transfer_in', 'reverse'
);

CREATE TABLE stock_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  variant_id          uuid NOT NULL REFERENCES product_variants(id),
  movement_type       movement_type NOT NULL,
  -- signed: + = in, - = out. Never zero.
  quantity            numeric(14,4) NOT NULL CHECK (quantity <> 0),
  unit_cost           numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  reference_type      text NOT NULL,          -- sale | grn | adjustment | count | transfer | manual
  reference_id        uuid,
  idempotency_key     text NOT NULL,
  -- business time is SERVER-assigned (trap: never trust client timestamps)
  business_time       timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX idx_ledger_branch_variant ON stock_ledger (org_id, branch_id, variant_id, business_time);
CREATE INDEX idx_ledger_reference     ON stock_ledger (org_id, reference_type, reference_id);

-- ---- Invariant 1: append-only ----
-- Statement-level on purpose: with RLS enabled and no UPDATE/DELETE policy,
-- PostgreSQL silently FILTERS rows instead of erroring, so a row-level
-- BEFORE trigger would never fire for the app role. A statement-level
-- trigger raises for ANY UPDATE/DELETE statement, for every role.
CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'stock_ledger is append-only: UPDATE forbidden'
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_ledger is append-only: DELETE forbidden'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_stock_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

-- ---- Invariant 2: derived cache, maintained only by this trigger ----
CREATE TABLE inventory_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id         uuid NOT NULL REFERENCES branches(id),
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  quantity_on_hand  numeric(14,4) NOT NULL DEFAULT 0,
  last_movement_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, branch_id, variant_id)
);

-- SECURITY DEFINER: runs as the migration owner so RLS never blocks the
-- derived-cache write, while client roles have NO insert/update policy on
-- inventory_items (they cannot write balances directly, ever).
CREATE FUNCTION apply_stock_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO inventory_items (org_id, branch_id, variant_id, quantity_on_hand, last_movement_at)
  VALUES (NEW.org_id, NEW.branch_id, NEW.variant_id, NEW.quantity, NEW.business_time)
  ON CONFLICT (org_id, branch_id, variant_id) DO UPDATE SET
    quantity_on_hand = inventory_items.quantity_on_hand + EXCLUDED.quantity_on_hand,
    last_movement_at = EXCLUDED.last_movement_at,
    updated_at       = now();
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_stock_ledger_apply
  AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION apply_stock_ledger();

-- RLS: SELECT-only for the app role (no INSERT/UPDATE/DELETE policies).
ALTER TABLE stock_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_select ON stock_ledger
  FOR SELECT USING (org_id = tenant_org_id());
CREATE POLICY ledger_insert ON stock_ledger
  FOR INSERT WITH CHECK (org_id = tenant_org_id());

ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_select ON inventory_items
  FOR SELECT USING (org_id = tenant_org_id());

-- ---- Three core views (security_invoker keeps RLS applied through views) ----
CREATE VIEW v_stock_ledger_full
WITH (security_invoker = true) AS
SELECT sl.id, sl.org_id, sl.branch_id, b.name AS branch_name,
       sl.variant_id, pv.name AS variant_name, p.id AS product_id, p.name AS product_name,
       sl.movement_type, sl.quantity, sl.unit_cost,
       sl.reference_type, sl.reference_id, sl.idempotency_key,
       sl.business_time, sl.created_at, u.name AS created_by_name
FROM stock_ledger sl
JOIN branches b          ON b.id = sl.branch_id
JOIN product_variants pv ON pv.id = sl.variant_id
JOIN products p          ON p.id = pv.product_id
LEFT JOIN users u        ON u.id = sl.created_by_user_id;

CREATE VIEW v_inventory_balances
WITH (security_invoker = true) AS
SELECT ii.org_id, ii.branch_id, b.name AS branch_name,
       ii.variant_id, pv.name AS variant_name, p.id AS product_id, p.name AS product_name,
       ii.quantity_on_hand, ii.last_movement_at, ii.updated_at
FROM inventory_items ii
JOIN branches b          ON b.id = ii.branch_id
JOIN product_variants pv ON pv.id = ii.variant_id
JOIN products p          ON p.id = pv.product_id;

-- The reconciliation test view: ledger sum vs derived balance per item.
-- delta MUST be 0 for every row — the invariant that proves balances are
-- reproducible from the ledger alone.
CREATE VIEW v_stock_reconciliation
WITH (security_invoker = true) AS
SELECT sl.org_id, sl.branch_id, sl.variant_id,
       SUM(sl.quantity) AS ledger_quantity,
       MAX(ii.quantity_on_hand) AS inventory_quantity,
       SUM(sl.quantity) - MAX(ii.quantity_on_hand) AS delta
FROM stock_ledger sl
LEFT JOIN inventory_items ii
  ON ii.org_id = sl.org_id AND ii.branch_id = sl.branch_id AND ii.variant_id = sl.variant_id
GROUP BY sl.org_id, sl.branch_id, sl.variant_id;
