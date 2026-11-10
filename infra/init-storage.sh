#!/bin/sh
set -eu
attempt=0
until mc alias set sdp http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'Object storage did not become ready.' >&2; exit 1; fi
  sleep 2
done
mc mb --ignore-existing sdp/sdp-private
mc anonymous set none sdp/sdp-private
mc admin user add sdp "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
mc admin policy create sdp sdp-private /setup/policy.json
mc admin policy attach sdp sdp-private --user "$S3_ACCESS_KEY"
