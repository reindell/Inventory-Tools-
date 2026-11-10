-- Native Microsoft SQL Server 2022+ schema. No PostgreSQL emulation service is used.
CREATE TABLE dbo.users (
 id uniqueidentifier NOT NULL CONSTRAINT PK_users PRIMARY KEY DEFAULT NEWID(),
 email nvarchar(254) NOT NULL CONSTRAINT UQ_users_email UNIQUE,
 name nvarchar(150) NOT NULL, password_hash nvarchar(128) NOT NULL,
 role nvarchar(16) NOT NULL CHECK(role IN ('Admin','Manager','Staff','Viewer')),
 enabled bit NOT NULL DEFAULT 1, failed_logins int NOT NULL DEFAULT 0,
 locked_until datetime2(3) NULL, token_version int NOT NULL DEFAULT 1,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.sessions (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(), user_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 family_id uniqueidentifier NOT NULL, token_hash nvarchar(64) NOT NULL UNIQUE,
 expires_at datetime2(3) NOT NULL, rotated_at datetime2(3) NULL, revoked_at datetime2(3) NULL,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX sessions_user ON dbo.sessions(user_id);
CREATE TABLE dbo.reset_tokens (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(), user_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 token_hash nvarchar(64) NOT NULL UNIQUE, expires_at datetime2(3) NOT NULL, consumed_at datetime2(3) NULL
);
CREATE TABLE dbo.invitations (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(), email nvarchar(254) NOT NULL,
 role nvarchar(16) NOT NULL CHECK(role IN ('Admin','Manager','Staff','Viewer')),
 token_hash nvarchar(64) NOT NULL UNIQUE, invited_by uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 expires_at datetime2(3) NOT NULL, consumed_at datetime2(3) NULL
);
CREATE TABLE dbo.locations(id int NOT NULL PRIMARY KEY CHECK(id=1),name nvarchar(150) NOT NULL);
INSERT INTO dbo.locations(id,name) VALUES (1,'Production');
CREATE TABLE dbo.categories(name nvarchar(80) NOT NULL PRIMARY KEY);
CREATE TABLE dbo.suppliers(name nvarchar(150) NOT NULL PRIMARY KEY);
CREATE TABLE dbo.items (
 id uniqueidentifier NOT NULL CONSTRAINT PK_items PRIMARY KEY DEFAULT NEWID(),
 name nvarchar(150) NOT NULL, sku nvarchar(64) NOT NULL,
 sku_normalized nvarchar(64) NOT NULL CONSTRAINT UQ_items_sku UNIQUE,
 barcode nvarchar(100) NULL, barcode_normalized nvarchar(100) NULL,
 category nvarchar(80) NOT NULL REFERENCES dbo.categories(name), supplier nvarchar(150) NULL REFERENCES dbo.suppliers(name),
 description nvarchar(max) NOT NULL DEFAULT '',
 unit_price decimal(19,4) NOT NULL DEFAULT 0 CHECK(unit_price>=0),
 unit_cost decimal(19,4) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),
 serialized bit NOT NULL DEFAULT 0, status nvarchar(16) NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 version int NOT NULL DEFAULT 1, created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UQ_items_barcode ON dbo.items(barcode_normalized) WHERE barcode_normalized IS NOT NULL;
CREATE INDEX items_category_status_created ON dbo.items(category,status,created_at,id);
CREATE INDEX items_created ON dbo.items(created_at,id);
CREATE TABLE dbo.stock_balances (
 item_id uniqueidentifier NOT NULL PRIMARY KEY REFERENCES dbo.items(id),
 location_id int NOT NULL DEFAULT 1 REFERENCES dbo.locations(id) CHECK(location_id=1),
 quantity int NOT NULL DEFAULT 0 CHECK(quantity BETWEEN 0 AND 1000000000),
 reorder_level int NOT NULL DEFAULT 10 CHECK(reorder_level BETWEEN 0 AND 1000000000), version int NOT NULL DEFAULT 1
);
CREATE TABLE dbo.item_images (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(), item_id uniqueidentifier NOT NULL REFERENCES dbo.items(id),
 object_key nvarchar(256) NOT NULL UNIQUE, thumbnail_key nvarchar(256) NOT NULL UNIQUE,
 sort_order int NOT NULL DEFAULT 0,is_primary bit NOT NULL DEFAULT 0,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX images_one_primary ON dbo.item_images(item_id) WHERE is_primary=1;
CREATE TABLE dbo.idempotency_records (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(), actor_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 route nvarchar(100) NOT NULL,[key] nvarchar(100) NOT NULL,request_hash nvarchar(64) NOT NULL,
 response_json nvarchar(max) NULL CHECK(response_json IS NULL OR ISJSON(response_json)=1),
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UNIQUE(actor_id,route,[key])
);
CREATE TABLE dbo.stock_movements (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),item_id uniqueidentifier NOT NULL REFERENCES dbo.items(id),
 location_id int NOT NULL DEFAULT 1 REFERENCES dbo.locations(id) CHECK(location_id=1),
 type nvarchar(16) NOT NULL CHECK(type IN ('in','out','adjustment')),
 delta int NOT NULL CHECK(delta<>0),balance_after int NOT NULL CHECK(balance_after BETWEEN 0 AND 1000000000),
 reason nvarchar(200) NOT NULL,note nvarchar(max) NOT NULL DEFAULT '',unit_cost_snapshot decimal(19,4) NOT NULL,
 actor_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),idempotency_id uniqueidentifier NULL REFERENCES dbo.idempotency_records(id),
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX movements_idempotency ON dbo.stock_movements(idempotency_id) WHERE idempotency_id IS NOT NULL;
CREATE INDEX movements_item_date ON dbo.stock_movements(item_id,created_at,id);
CREATE INDEX movements_date ON dbo.stock_movements(created_at,id);
CREATE TABLE dbo.serial_units (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),item_id uniqueidentifier NOT NULL REFERENCES dbo.items(id),
 serial nvarchar(100) NOT NULL,serial_normalized nvarchar(100) NOT NULL UNIQUE,
 status nvarchar(16) NOT NULL CHECK(status IN ('in_stock','sold','damaged')),
 location_id int NOT NULL DEFAULT 1 REFERENCES dbo.locations(id) CHECK(location_id=1)
);
CREATE TABLE dbo.serial_events (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),serial_id uniqueidentifier NOT NULL REFERENCES dbo.serial_units(id),
 movement_id uniqueidentifier NOT NULL REFERENCES dbo.stock_movements(id),from_status nvarchar(16) NULL,to_status nvarchar(16) NOT NULL,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.brand_assets (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),object_key nvarchar(256) NOT NULL UNIQUE,checksum nvarchar(64) NOT NULL,
 uploaded_by uniqueidentifier NOT NULL REFERENCES dbo.users(id),created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.company_settings (
 id int NOT NULL PRIMARY KEY CHECK(id=1),company_name nvarchar(254) NOT NULL,
 app_name nvarchar(100) NOT NULL DEFAULT 'SDP Inventory',currency nvarchar(3) NOT NULL DEFAULT 'USD',
 timezone nvarchar(100) NOT NULL DEFAULT 'Asia/Shanghai',logo_asset_id uniqueidentifier NULL REFERENCES dbo.brand_assets(id),brand_version int NOT NULL DEFAULT 1
);
INSERT INTO dbo.company_settings(id,company_name) VALUES (1,'SHINDENGEN ELECTRIC MFG.CO.,LTD');
CREATE TABLE dbo.audit_events (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),actor_id uniqueidentifier NULL REFERENCES dbo.users(id),
 action nvarchar(100) NOT NULL,entity_type nvarchar(80) NOT NULL,entity_id nvarchar(128) NULL,
 before_data nvarchar(max) NULL CHECK(before_data IS NULL OR ISJSON(before_data)=1 OR before_data='null'),
 after_data nvarchar(max) NULL CHECK(after_data IS NULL OR ISJSON(after_data)=1 OR after_data='null'),
 request_id nvarchar(100) NULL,created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX audit_entity_date ON dbo.audit_events(entity_type,entity_id,created_at);
CREATE INDEX audit_actor_date ON dbo.audit_events(actor_id,created_at);
CREATE TABLE dbo.outbox (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),type nvarchar(50) NOT NULL,
 payload nvarchar(max) NOT NULL CHECK(ISJSON(payload)=1),
 state nvarchar(16) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','failed')),
 attempts int NOT NULL DEFAULT 0,available_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),lease_until datetime2(3) NULL,
 dedup_key nvarchar(256) NULL,last_error nvarchar(max) NULL,created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX outbox_dedup ON dbo.outbox(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX outbox_pending ON dbo.outbox(state,available_at);
CREATE TABLE dbo.import_jobs (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),actor_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),
 [rows] nvarchar(max) NOT NULL CHECK(ISJSON([rows])=1),[errors] nvarchar(max) NOT NULL CHECK(ISJSON([errors])=1),
 status nvarchar(16) NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','committed')),
 result nvarchar(max) NULL CHECK(result IS NULL OR ISJSON(result)=1),created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE TRIGGER dbo.audit_immutable ON dbo.audit_events AFTER UPDATE,DELETE AS
BEGIN SET NOCOUNT ON; THROW 51002,'History is append-only',1; END;
GO
CREATE TRIGGER dbo.ledger_immutable ON dbo.stock_movements AFTER UPDATE,DELETE AS
BEGIN SET NOCOUNT ON; THROW 51002,'History is append-only',1; END;
GO
CREATE TRIGGER dbo.serial_history_immutable ON dbo.serial_events AFTER UPDATE,DELETE AS
BEGIN SET NOCOUNT ON; THROW 51002,'History is append-only',1; END;
