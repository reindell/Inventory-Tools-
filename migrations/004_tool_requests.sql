INSERT INTO categories(name) VALUES ('Tools'),('Jigs') ON CONFLICT DO NOTHING;
CREATE TABLE tool_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES items(id),
 requester_id uuid NOT NULL REFERENCES users(id), quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000000),
 issued_quantity integer NOT NULL DEFAULT 0, returned_quantity integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','issued','returned')),
 purpose text NOT NULL, decision_note text NOT NULL DEFAULT '', decided_by uuid REFERENCES users(id), decided_at timestamptz,
 issued_at timestamptz, issue_movement_id uuid UNIQUE REFERENCES stock_movements(id),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(issued_quantity BETWEEN 0 AND quantity), CHECK(returned_quantity BETWEEN 0 AND issued_quantity),
 CHECK((status IN ('pending','approved','rejected','cancelled') AND issued_quantity=0 AND returned_quantity=0 AND issued_at IS NULL AND issue_movement_id IS NULL)
 OR (status='issued' AND issued_quantity>0 AND returned_quantity<issued_quantity AND issued_at IS NOT NULL AND issue_movement_id IS NOT NULL)
 OR (status='returned' AND issued_quantity>0 AND returned_quantity=issued_quantity AND issued_at IS NOT NULL AND issue_movement_id IS NOT NULL))
);
CREATE INDEX requests_owner_created ON tool_requests(requester_id,created_at,id);
CREATE INDEX requests_status_created ON tool_requests(status,created_at,id);
CREATE INDEX requests_item_status ON tool_requests(item_id,status);
CREATE TABLE request_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES tool_requests(id),
 actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL CHECK(action IN ('created','approved','rejected','cancelled','issued','returned')),
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity>=0), note text NOT NULL DEFAULT '', movement_id uuid REFERENCES stock_movements(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_events_date ON request_events(request_id,created_at,id);
CREATE TRIGGER request_history_immutable BEFORE UPDATE OR DELETE ON request_events FOR EACH ROW EXECUTE FUNCTION prevent_history_changes();
CREATE TABLE request_serials (
 request_id uuid NOT NULL REFERENCES tool_requests(id), serial_id uuid NOT NULL REFERENCES serial_units(id), returned_at timestamptz,
 PRIMARY KEY(request_id,serial_id)
);
CREATE UNIQUE INDEX request_serials_one_loan ON request_serials(serial_id) WHERE returned_at IS NULL;
CREATE TABLE user_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL REFERENCES tool_requests(id),
 title text NOT NULL, message text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_date ON user_notifications(user_id,created_at,id);
CREATE INDEX notifications_user_unread ON user_notifications(user_id,read_at);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sdp_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON tool_requests,request_serials,user_notifications TO sdp_app;
  GRANT SELECT,INSERT ON request_events TO sdp_app;
  REVOKE UPDATE,DELETE ON request_events FROM sdp_app;
 END IF;
END $$;
