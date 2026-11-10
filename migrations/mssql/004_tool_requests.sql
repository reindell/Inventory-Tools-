IF NOT EXISTS (SELECT 1 FROM dbo.categories WHERE name='Tools') INSERT INTO dbo.categories(name) VALUES ('Tools');
IF NOT EXISTS (SELECT 1 FROM dbo.categories WHERE name='Jigs') INSERT INTO dbo.categories(name) VALUES ('Jigs');
CREATE TABLE dbo.tool_requests (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),item_id uniqueidentifier NOT NULL REFERENCES dbo.items(id),
 requester_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),quantity int NOT NULL CHECK(quantity BETWEEN 1 AND 1000000000),
 issued_quantity int NOT NULL DEFAULT 0,returned_quantity int NOT NULL DEFAULT 0,
 status nvarchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','issued','returned')),
 purpose nvarchar(max) NOT NULL,decision_note nvarchar(max) NOT NULL DEFAULT '',decided_by uniqueidentifier NULL REFERENCES dbo.users(id),decided_at datetime2(3) NULL,
 issued_at datetime2(3) NULL,issue_movement_id uniqueidentifier NULL REFERENCES dbo.stock_movements(id),
 version int NOT NULL DEFAULT 1 CHECK(version>0),created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),updated_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
 CHECK(issued_quantity BETWEEN 0 AND quantity),CHECK(returned_quantity BETWEEN 0 AND issued_quantity),
 CHECK((status IN ('pending','approved','rejected','cancelled') AND issued_quantity=0 AND returned_quantity=0 AND issued_at IS NULL AND issue_movement_id IS NULL)
 OR (status='issued' AND issued_quantity>0 AND returned_quantity<issued_quantity AND issued_at IS NOT NULL AND issue_movement_id IS NOT NULL)
 OR (status='returned' AND issued_quantity>0 AND returned_quantity=issued_quantity AND issued_at IS NOT NULL AND issue_movement_id IS NOT NULL))
);
CREATE UNIQUE INDEX request_issue_movement ON dbo.tool_requests(issue_movement_id) WHERE issue_movement_id IS NOT NULL;
CREATE INDEX requests_owner_created ON dbo.tool_requests(requester_id,created_at,id);
CREATE INDEX requests_status_created ON dbo.tool_requests(status,created_at,id);
CREATE INDEX requests_item_status ON dbo.tool_requests(item_id,status);
CREATE TABLE dbo.request_events (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),request_id uniqueidentifier NOT NULL REFERENCES dbo.tool_requests(id),
 actor_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),action nvarchar(16) NOT NULL CHECK(action IN ('created','approved','rejected','cancelled','issued','returned')),
 quantity int NOT NULL DEFAULT 0 CHECK(quantity>=0),note nvarchar(max) NOT NULL DEFAULT '',movement_id uniqueidentifier NULL REFERENCES dbo.stock_movements(id),created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX request_events_date ON dbo.request_events(request_id,created_at,id);
CREATE TABLE dbo.request_serials (
 request_id uniqueidentifier NOT NULL REFERENCES dbo.tool_requests(id),serial_id uniqueidentifier NOT NULL REFERENCES dbo.serial_units(id),returned_at datetime2(3) NULL,
 PRIMARY KEY(request_id,serial_id)
);
CREATE UNIQUE INDEX request_serials_one_loan ON dbo.request_serials(serial_id) WHERE returned_at IS NULL;
CREATE TABLE dbo.user_notifications (
 id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),user_id uniqueidentifier NOT NULL REFERENCES dbo.users(id),request_id uniqueidentifier NOT NULL REFERENCES dbo.tool_requests(id),
 title nvarchar(200) NOT NULL,message nvarchar(max) NOT NULL,read_at datetime2(3) NULL,created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX notifications_user_date ON dbo.user_notifications(user_id,created_at,id);
CREATE INDEX notifications_user_unread ON dbo.user_notifications(user_id,read_at);
DENY UPDATE,DELETE ON dbo.request_events TO sdp_runtime;
GO
CREATE TRIGGER dbo.request_history_immutable ON dbo.request_events AFTER UPDATE,DELETE AS
BEGIN SET NOCOUNT ON; THROW 51002,'History is append-only',1; END;
