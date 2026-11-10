-- The database bootstrap creates this role; every runtime account belongs only to it.
IF DATABASE_PRINCIPAL_ID(N'sdp_runtime') IS NULL CREATE ROLE sdp_runtime AUTHORIZATION dbo;
GRANT SELECT,INSERT,UPDATE,DELETE ON SCHEMA::dbo TO sdp_runtime;
DENY UPDATE,DELETE ON dbo.audit_events TO sdp_runtime;
DENY UPDATE,DELETE ON dbo.stock_movements TO sdp_runtime;
DENY UPDATE,DELETE ON dbo.serial_events TO sdp_runtime;
DENY INSERT,UPDATE,DELETE ON dbo.schema_migrations TO sdp_runtime;
DENY INSERT,DELETE ON dbo.locations TO sdp_runtime;
DENY INSERT,DELETE ON dbo.company_settings TO sdp_runtime;
