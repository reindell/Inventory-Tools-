#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password APP_DB_PASSWORD
CREATE ROLE sdp_app LOGIN PASSWORD :'runtime_password';
GRANT CONNECT ON DATABASE sdp TO sdp_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
