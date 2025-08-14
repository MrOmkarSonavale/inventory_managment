--  Companies & multi-warehouse support
CREATE TABLE companies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- Product catalog
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT NOT NULL,                        -- global SKU; enforce uniqueness below
  name TEXT NOT NULL,
  description TEXT,
  is_bundle BOOLEAN NOT NULL DEFAULT FALSE, -- true if product is a bundle composed of components
  product_type TEXT,                        -- optional categorization
  price NUMERIC(12,2) NOT NULL DEFAULT 0,   -- money stored as NUMERIC
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- enforce global uniqueness of SKUs (requirement states global unique)
CREATE UNIQUE INDEX uq_products_sku_lower ON products (lower(sku));

-- Inventory snapshot per (product, warehouse)
CREATE TABLE inventories (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  safety_stock NUMERIC(14,3) DEFAULT 0 CHECK (safety_stock >= 0),
  reorder_point NUMERIC(14,3), -- optional per-warehouse reorder threshold
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, warehouse_id)
);

-- Immutable inventory ledger (audit of all inventory deltas)
CREATE TABLE inventory_ledger (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity_delta NUMERIC(14,3) NOT NULL,    -- positive for stock in, negative for out
  reason TEXT NOT NULL,                     -- e.g., 'sale', 'purchase', 'transfer_in'
  ref_type TEXT,                            -- e.g., 'sales_order', 'purchase_order', 'transfer'
  ref_id BIGINT,                            -- optional id of referenced record
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suppliers and mapping to products
CREATE TABLE suppliers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_products (
  supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  cost NUMERIC(12,2),
  lead_time_days INTEGER,
  min_order_qty NUMERIC(14,3),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (supplier_id, product_id)
);

-- Bundles: mapping bundle product -> component product
CREATE TABLE bundle_items (
  bundle_product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (bundle_product_id, component_product_id),
  -- ensure bundle_product is marked as a bundle at application-time or via a CHECK functional index if desired
  UNIQUE (bundle_product_id, component_product_id)
);