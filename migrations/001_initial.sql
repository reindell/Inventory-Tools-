CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('Admin','Manager','Staff','Viewer')),
 enabled boolean NOT NULL DEFAULT true, failed_logins integer NOT NULL DEFAULT 0,
 locked_until timestamptz, token_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 family_id uuid NOT NULL, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 rotated_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE reset_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, role text NOT NULL CHECK(role IN ('Admin','Manager','Staff','Viewer')), token_hash text NOT NULL UNIQUE, invited_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE locations (id integer PRIMARY KEY CHECK(id = 1), name text NOT NULL);
INSERT INTO locations(id,name) VALUES (1,'Production');
CREATE TABLE categories (name text PRIMARY KEY);
CREATE TABLE suppliers (name text PRIMARY KEY);
CREATE TABLE items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, sku text NOT NULL,
 sku_normalized text NOT NULL UNIQUE, barcode text, barcode_normalized text UNIQUE,
 category text NOT NULL REFERENCES categories(name), supplier text REFERENCES suppliers(name),
 description text NOT NULL DEFAULT '', unit_price numeric(19,4) NOT NULL CHECK(unit_price >= 0),
 unit_cost numeric(19,4) NOT NULL CHECK(unit_cost >= 0), serialized boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_category_status_created ON items(category,status,created_at,id);
CREATE INDEX items_created ON items(created_at,id);
CREATE TABLE stock_balances (
 item_id uuid PRIMARY KEY REFERENCES items(id), location_id integer NOT NULL DEFAULT 1 REFERENCES locations(id) CHECK(location_id = 1),
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity BETWEEN 0 AND 1000000000),
 reorder_level integer NOT NULL DEFAULT 10 CHECK(reorder_level BETWEEN 0 AND 1000000000),
 version integer NOT NULL DEFAULT 1
);
CREATE TABLE item_images (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id), object_key text NOT NULL UNIQUE,
 thumbnail_key text NOT NULL UNIQUE, sort_order integer NOT NULL DEFAULT 0, is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX images_one_primary ON item_images(item_id) WHERE is_primary;
CREATE TABLE idempotency_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users(id), route text NOT NULL,
 key text NOT NULL, request_hash text NOT NULL, response_json jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,route,key)
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id),
 location_id integer NOT NULL DEFAULT 1 REFERENCES locations(id) CHECK(location_id = 1),
 type text NOT NULL CHECK(type IN ('in','out','adjustment')), delta integer NOT NULL CHECK(delta != 0),
 balance_after integer NOT NULL CHECK(balance_after BETWEEN 0 AND 1000000000), reason text NOT NULL, note text NOT NULL DEFAULT '',
 unit_cost_snapshot numeric(19,4) NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 idempotency_id uuid UNIQUE REFERENCES idempotency_records(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movements_item_date ON stock_movements(item_id,created_at,id);
CREATE INDEX movements_date ON stock_movements(created_at,id);
CREATE TABLE serial_units (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id), serial text NOT NULL, serial_normalized text NOT NULL UNIQUE, status text NOT NULL CHECK(status IN ('in_stock','sold','damaged')), location_id integer NOT NULL DEFAULT 1 REFERENCES locations(id) CHECK(location_id = 1));
CREATE TABLE serial_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), serial_id uuid NOT NULL REFERENCES serial_units(id), movement_id uuid NOT NULL REFERENCES stock_movements(id), from_status text, to_status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE brand_assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), object_key text NOT NULL UNIQUE, checksum text NOT NULL, uploaded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE company_settings (id integer PRIMARY KEY CHECK(id = 1), company_name text NOT NULL, app_name text NOT NULL DEFAULT 'SDP Inventory', currency text NOT NULL DEFAULT 'USD', timezone text NOT NULL DEFAULT 'Asia/Shanghai', logo_asset_id uuid REFERENCES brand_assets(id), brand_version integer NOT NULL DEFAULT 1);
INSERT INTO company_settings(id,company_name) VALUES (1,'SHINDENGEN ELECTRIC MFG.CO.,LTD');
CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES users(id), action text NOT NULL, entity_type text NOT NULL, entity_id text, before_data jsonb, after_data jsonb, request_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_entity_date ON audit_events(entity_type,entity_id,created_at);
CREATE INDEX audit_actor_date ON audit_events(actor_id,created_at);
CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','failed')), attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, dedup_key text UNIQUE, last_error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_pending ON outbox(state,available_at);
CREATE TABLE import_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users(id), rows jsonb NOT NULL, errors jsonb NOT NULL, status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','committed')), result jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION prevent_history_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'History is append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_history_changes();
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION prevent_history_changes();
CREATE TRIGGER serial_history_immutable BEFORE UPDATE OR DELETE ON serial_events FOR EACH ROW EXECUTE FUNCTION prevent_history_changes();
