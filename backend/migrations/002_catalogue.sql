-- ============================================================================
-- FlowWise — Migration 002: catalogue (Phase 0 exit: branch-scoped catalogue
-- pull). All tables tenant-scoped with RLS. numeric(14,4) for money.
-- ============================================================================

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES categories(id) ON DELETE SET NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, parent_id, name)
);

CREATE TABLE units_of_measure (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, code)
);

CREATE TABLE taxes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  rate       numeric(6,4) NOT NULL CHECK (rate >= 0 AND rate <= 1),
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, name)
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  uom_id      uuid REFERENCES units_of_measure(id) ON DELETE SET NULL,
  name        text NOT NULL,
  sku         text,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_products_org_sku ON products (org_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX idx_products_org_name ON products (org_id, lower(name));

CREATE TABLE product_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       text NOT NULL,
  sku        text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_variants_org_sku ON product_variants (org_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX idx_variants_org_product ON product_variants (org_id, product_id);

-- Barcode → variant is THE hot path for the till (sub-300ms local resolve).
CREATE TABLE barcodes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  barcode    text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, barcode)
);
CREATE INDEX idx_barcodes_org_code ON barcodes (org_id, barcode);

CREATE TABLE price_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  currency   char(3) NOT NULL DEFAULT 'BWP',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE price_list_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  variant_id    uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  price         numeric(14,4) NOT NULL CHECK (price >= 0),
  valid_from    timestamptz,
  valid_to      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, price_list_id, variant_id)
);
CREATE INDEX idx_pli_variant ON price_list_items (org_id, variant_id);

-- ---- RLS ----
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY categories_tenant ON categories
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE units_of_measure ENABLE ROW LEVEL SECURITY;
CREATE POLICY uom_tenant ON units_of_measure
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE taxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY taxes_tenant ON taxes
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_tenant ON products
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY variants_tenant ON product_variants
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE barcodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY barcodes_tenant ON barcodes
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_lists_tenant ON price_lists
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());

ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY pli_tenant ON price_list_items
  USING (org_id = tenant_org_id()) WITH CHECK (org_id = tenant_org_id());
