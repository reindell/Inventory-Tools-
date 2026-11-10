DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sdp_app') THEN
  GRANT USAGE ON SCHEMA public TO sdp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sdp_app;
  REVOKE UPDATE, DELETE ON audit_events, stock_movements, serial_events FROM sdp_app;
  REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM sdp_app;
  REVOKE INSERT, DELETE ON locations, company_settings FROM sdp_app;
 END IF;
END $$;
