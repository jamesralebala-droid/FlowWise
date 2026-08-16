-- ============================================================================
-- FlowWise — Migration 008: hardening & rollout (Phase 4).
--
-- 1. auth_attempts — brute-force protection for the pre-auth login endpoint.
--    The authorize endpoint is the ONLY password entry point and it runs with
--    no tenant context, so this is deliberately a SYSTEM table (no RLS, same
--    treatment as oauth_clients). It stores only a hashed IP, a normalized
--    username and a timestamp — no secrets. The app role needs table DML on
--    it (covered by the standard "grant DML on the public schema" role setup;
--    on new tables, run ALTER DEFAULT PRIVILEGES or grant explicitly).
-- 2. movement_type 'opening' — ledger entries written by the legacy data
--    import (Phase 4 "data import"): opening balances enter the append-only
--    ledger like any other movement, so inventory_items is derived exactly as
--    everywhere else (Invariants 1 & 2).
-- ============================================================================

CREATE TABLE auth_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- normalized lowercase username (may name a user that does not exist —
  -- failed attempts on unknown users count the same, to avoid account
  -- enumeration through throttle behaviour)
  username     text NOT NULL,
  -- sha256 hex of the client IP (never stored raw)
  ip_hash      text NOT NULL,
  success      boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_attempts_key_time
  ON auth_attempts (username, ip_hash, attempted_at DESC);

-- Imported opening balances use a distinct movement type so the audit trail
-- can tell "system import" from a manual adjustment, and the import can be
-- made replay-safe (see import idempotency_key logic).
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'opening';
