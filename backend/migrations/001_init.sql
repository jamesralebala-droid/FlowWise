-- ============================================================================
-- FlowWise — Migration 001: multi-tenancy, RBAC, OAuth2, devices, audit, RLS
-- PostgreSQL 15+. Money/quantity are ALWAYS numeric, never float.
-- Every tenant-scoped table gets RLS on org_id (via session GUC) and is
-- written through the app role, never by clients directly.
-- ============================================================================

-- Phase 0 needs no extensions: gen_random_uuid() is core since PG 13.
-- (Revisit pgcrypto/pg_trgm when Phase 1 search/full-text lands.)

-- ---------------------------------------------------------------------------
-- Organisations (tenant root)
-- ---------------------------------------------------------------------------
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  currency_code char(3) NOT NULL DEFAULT 'BWP',
  timezone      text NOT NULL DEFAULT 'Africa/Gaborone',
  vat_rate      numeric(6,4) NOT NULL DEFAULT 0.1400
                CHECK (vat_rate >= 0 AND vat_rate <= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  code       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

-- ---------------------------------------------------------------------------
-- Users (one org per user; roles are assigned per branch)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Devices (bound to a user + org; device key stored hashed, never raw)
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name     text NOT NULL,
  platform        text NOT NULL,
  app_version     text,
  device_key_hash text NOT NULL UNIQUE,
  is_active       boolean NOT NULL DEFAULT true,
  bound_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_org  ON devices (org_id);
CREATE INDEX idx_devices_user ON devices (user_id);

-- ---------------------------------------------------------------------------
-- RBAC: 5 system roles + permission catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  category    text
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

-- branch_id NULL => org-wide scope. A user can hold different roles per branch.
CREATE TABLE user_role_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id  uuid REFERENCES branches(id) ON DELETE CASCADE,
  role_code  text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, branch_id, role_code)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only; every privileged/business action writes a row)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid REFERENCES organisations(id) ON DELETE CASCADE,
  actor_user_id   uuid,
  actor_device_id uuid,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  old_data        jsonb,
  new_data        jsonb,
  ip              inet,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_log (org_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- OAuth2: public client registry, PKCE authorization codes, rotating refresh
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text NOT NULL UNIQUE,
  client_secret_hash text,
  name               text NOT NULL,
  redirect_uris      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authorization_codes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  client_id             text NOT NULL,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash             text NOT NULL UNIQUE,
  redirect_uri          text NOT NULL,
  code_challenge        text,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scope                 text,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_id      text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  family_id      uuid NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user   ON refresh_tokens (org_id, user_id);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);

-- ---------------------------------------------------------------------------
-- HTTP idempotency: a write that carries an Idempotency-Key header is
-- replayed to the same response instead of being executed twice (Invariant 4)
-- ---------------------------------------------------------------------------
CREATE TABLE http_idempotency (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key           text NOT NULL,
  method        text NOT NULL,
  path          text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

-- ============================================================================
-- RLS plumbing
-- ============================================================================
CREATE OR REPLACE FUNCTION tenant_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION tenant_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION tenant_device_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_device_id', true), '')::uuid
$$;

-- Audit helper. Called by application code inside the request transaction;
-- actor/org come from the session GUCs, never from client input.
CREATE OR REPLACE FUNCTION fn_write_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid DEFAULT NULL,
  p_old_data    jsonb DEFAULT NULL,
  p_new_data    jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (org_id, actor_user_id, actor_device_id,
                         action, entity_type, entity_id, old_data, new_data)
  VALUES (tenant_org_id(), tenant_user_id(), tenant_device_id(),
          p_action, p_entity_type, p_entity_id, p_old_data, p_new_data);
END
$$;

-- Security-definer helpers for the few lookups that must run BEFORE any
-- tenant context exists (login, token exchange). These functions execute as
-- the migration owner (a BYPASSRLS role in production; superuser in PGlite)
-- and are the ONLY path to these tables without a tenant GUC.
CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email text)
RETURNS TABLE (id uuid, org_id uuid, email text, name text, password_hash text, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, email, name, password_hash, is_active
  FROM users
  WHERE lower(email) = lower(p_email)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION oauth_lookup_code_by_hash(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, client_id text, user_id uuid, redirect_uri text,
               code_challenge text, code_challenge_method text, expires_at timestamptz, used_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, client_id, user_id, redirect_uri, code_challenge,
         code_challenge_method, expires_at, used_at
  FROM authorization_codes
  WHERE code_hash = p_hash
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION oauth_lookup_refresh_by_hash(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, user_id uuid, device_id uuid, client_id text,
               family_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, user_id, device_id, client_id, family_id, expires_at, revoked_at
  FROM refresh_tokens
  WHERE token_hash = p_hash
  LIMIT 1
$$;

-- ============================================================================
-- Enable RLS + policies. Pattern per tenant table:
--   USING  (org_id = tenant_org_id())  — reads/scans
--   WITH CHECK (org_id = tenant_org_id()) — writes must target own org
-- ============================================================================
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_tenant ON organisations
  USING (id = tenant_org_id()) WITH CHECK (id = tenant_org_id());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY branches_tenant ON branches
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY devices_tenant ON devices
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ura_tenant ON user_role_assignments
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_tenant ON audit_log
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE authorization_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_codes_tenant ON authorization_codes
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_tenant ON refresh_tokens
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE http_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY idem_tenant ON http_idempotency
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

-- ============================================================================
-- Seed: five system roles + permission catalogue + role mappings
-- ============================================================================
INSERT INTO roles (code, name, description) VALUES
  ('owner',            'Owner / Admin',   'Full control of the organisation'),
  ('branch_manager',   'Branch Manager',  'Runs a branch: sales, stock, POs'),
  ('cashier',          'Cashier',         'Operates the till at one branch'),
  ('stock_controller', 'Stock Controller','GRNs, counts, adjustments, transfers'),
  ('auditor',          'Auditor',         'Read-only access for assurance')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, name, description, category) VALUES
  ('settings.manage',   'Manage settings',    'Organisation configuration', 'Admin'),
  ('users.manage',      'Manage users',       'Create/edit users and roles', 'Admin'),
  ('branches.manage',   'Manage branches',    'Create/edit branches', 'Admin'),
  ('devices.manage',    'Manage devices',     'Register/revoke devices', 'Admin'),
  ('catalogue.read',    'Read catalogue',     'View products, prices, barcodes', 'Catalogue'),
  ('catalogue.manage',  'Manage catalogue',   'Create/edit products & prices', 'Catalogue'),
  ('pricing.manage',    'Manage pricing',     'Edit price lists', 'Catalogue'),
  ('pos.sell',          'Sell',               'Record sales at the till', 'Sales'),
  ('pos.refund',        'Refund',             'Process refunds', 'Sales'),
  ('pos.void',          'Void sale',          'Void an incomplete sale', 'Sales'),
  ('shift.open',        'Open shift',         'Open a till shift / cash-up', 'Sales'),
  ('shift.close',       'Close shift',        'Close and reconcile a shift', 'Sales'),
  ('sales.read',        'Read sales',         'View sales history & reports', 'Sales'),
  ('stock.read',        'Read stock',         'View balances and ledger', 'Stock'),
  ('stock.adjust',      'Adjust stock',       'Record approved adjustments', 'Stock'),
  ('stock.count',       'Count stock',        'Perform stock counts', 'Stock'),
  ('stock.transfer',    'Transfer stock',     'Initiate branch transfers', 'Stock'),
  ('stock.grn',         'Receive goods',      'Record GRNs', 'Stock'),
  ('purchase.reorder',  'Reorder rules',      'Manage reorder rules & forecasts', 'Procurement'),
  ('purchase.po',       'Purchase orders',    'Create/approve POs', 'Procurement'),
  ('reports.read',      'Read reports',       'View operational reports', 'Reports'),
  ('audit.read',        'Read audit log',     'View the audit trail', 'Reports')
ON CONFLICT (code) DO NOTHING;

-- owner: everything
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'owner', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  -- branch_manager
  ('branch_manager', 'catalogue.read'),
  ('branch_manager', 'catalogue.manage'),
  ('branch_manager', 'pos.sell'),
  ('branch_manager', 'pos.refund'),
  ('branch_manager', 'pos.void'),
  ('branch_manager', 'shift.open'),
  ('branch_manager', 'shift.close'),
  ('branch_manager', 'sales.read'),
  ('branch_manager', 'stock.read'),
  ('branch_manager', 'stock.adjust'),
  ('branch_manager', 'stock.count'),
  ('branch_manager', 'stock.transfer'),
  ('branch_manager', 'stock.grn'),
  ('branch_manager', 'purchase.reorder'),
  ('branch_manager', 'purchase.po'),
  ('branch_manager', 'reports.read'),
  ('branch_manager', 'devices.manage'),
  -- cashier
  ('cashier', 'catalogue.read'),
  ('cashier', 'pos.sell'),
  ('cashier', 'shift.open'),
  ('cashier', 'shift.close'),
  ('cashier', 'stock.read'),
  -- stock_controller
  ('stock_controller', 'catalogue.read'),
  ('stock_controller', 'catalogue.manage'),
  ('stock_controller', 'stock.read'),
  ('stock_controller', 'stock.adjust'),
  ('stock_controller', 'stock.count'),
  ('stock_controller', 'stock.transfer'),
  ('stock_controller', 'stock.grn'),
  ('stock_controller', 'purchase.reorder'),
  ('stock_controller', 'reports.read'),
  -- auditor (read-only)
  ('auditor', 'catalogue.read'),
  ('auditor', 'stock.read'),
  ('auditor', 'sales.read'),
  ('auditor', 'reports.read'),
  ('auditor', 'audit.read')
ON CONFLICT DO NOTHING;
