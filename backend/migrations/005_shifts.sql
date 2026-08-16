-- ============================================================================
-- FlowWise — Migration 005: shifts & cash-up (Phase 1).
--
-- A shift is the till session at one branch: opened by a user with the
-- opening float, closed with a cash-up where DECLARED tenders are compared
-- against SERVER-computed expectations (never client-supplied totals).
-- Rules:
--   * one OPEN shift per branch at a time (partial unique index)
--   * a closed shift is immutable — corrections are new records
--   * sales completed during a shift carry shift_id (optional in the API
--     for Phase 1; the till always provides it)
-- ============================================================================

CREATE TYPE shift_status AS ENUM ('open', 'closed');

CREATE TABLE shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  branch_id             uuid NOT NULL REFERENCES branches(id),
  user_id               uuid NOT NULL REFERENCES users(id),
  device_id             uuid REFERENCES devices(id) ON DELETE SET NULL,
  status                shift_status NOT NULL DEFAULT 'open',
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  opening_cash          numeric(14,4) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  -- declared tenders at cash-up (client input, validated as decimal strings)
  declared_cash         numeric(14,4) CHECK (declared_cash >= 0),
  declared_card         numeric(14,4) CHECK (declared_card >= 0),
  declared_mobile_money numeric(14,4) CHECK (declared_mobile_money >= 0),
  declared_credit       numeric(14,4) CHECK (declared_credit >= 0),
  declared_other        numeric(14,4) CHECK (declared_other >= 0),
  -- server-computed at close; never client-supplied
  expected_cash         numeric(14,4),
  expected_total        numeric(14,4),
  variance              numeric(14,4),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_shifts_one_open_per_branch
  ON shifts (org_id, branch_id) WHERE status = 'open';
CREATE INDEX idx_shifts_branch_time ON shifts (org_id, branch_id, opened_at DESC);

-- Sales belong to the shift that was open on the till at completion.
ALTER TABLE sales ADD COLUMN shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL;
CREATE INDEX idx_sales_shift ON sales (org_id, shift_id);

-- ---- Closed shifts are immutable ------------------------------------------
-- The open→closed transition is the ONLY allowed UPDATE; anything else on a
-- closed row (or any DELETE) raises, same rationale as the sales/ledger
-- statement-level triggers: RLS with no policy silently filters rows, so a
-- row-level guard would not fire for the app role.
CREATE FUNCTION protect_closed_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed shifts are immutable: % forbidden (use a new record)', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_shifts_protect
  BEFORE UPDATE OR DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION protect_closed_shift();

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY shifts_tenant ON shifts
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());
