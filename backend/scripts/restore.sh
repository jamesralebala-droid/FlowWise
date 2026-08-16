#!/usr/bin/env sh
# FlowWise — restore (Phase 4 "restore testing" runbook).
#
#   TARGET_DB_URL=postgres://migrator:***@host/flowwise_restore \
#     ./scripts/restore.sh backups/flowwise-<stamp>.dump
#
# Restores a custom-format dump into a FRESH target database on the same
# server (created from template0 if missing). Roles are global and must exist
# on the target server BEFORE restoring — create them once:
#   CREATE ROLE flowwise_migrator LOGIN BYPASSRLS;
#   CREATE ROLE flowwise_app NOLOGIN;
#   GRANT USAGE ON SCHEMA public TO flowwise_app;
#   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowwise_app;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowwise_app;
#
# Test the procedure regularly in staging: restore into a scratch database,
# boot the API against it, and confirm GET /v1/healthz plus a reconciliation
# query (see docs/OPS.md) both pass.
set -eu

dump="${1:?usage: restore.sh <backup.dump>}"
: "${TARGET_DB_URL:?TARGET_DB_URL is required (connection string of the database to restore INTO)}"

# Pull the database name out of the URL for the CREATE DATABASE step.
dbname=$(printf '%s' "$TARGET_DB_URL" | sed -E 's|^.*/([^/?]+)(\?.*)?$|\1|')
server_url=$(printf '%s' "$TARGET_DB_URL" | sed -E 's|/[^/?]+(\?.*)?$|/postgres\1|')

echo "Restoring $dump into database '$dbname'..."
if psql "$server_url" -tAc "SELECT 1 FROM pg_database WHERE datname = '$dbname'" | grep -q 1; then
  echo "Target database '$dbname' already exists — refusing to overwrite."
  exit 1
fi

psql "$server_url" -c "CREATE DATABASE \"$dbname\" TEMPLATE template0"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_DB_URL" "$dump"

echo "Restore complete. Verify:"
echo "  - GET /v1/healthz returns ok"
echo "  - a reconciliation query returns delta = 0 for all rows"
echo "    (see docs/OPS.md — 'Ledger reconciliation')"
