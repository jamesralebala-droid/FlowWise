#!/usr/bin/env sh
# FlowWise — backup (Phase 4 "restore testing" runbook).
#
#   DATABASE_URL=postgres://migrator:***@host/flowwise ./scripts/backup.sh [output.dump]
#
# Custom-format pg_dump: schema + data + triggers + RLS policies in one
# compressed file. Roles are global objects and are NOT dumped with
# --no-owner/--no-privileges; recreate them once on a fresh server (see
# restore.sh). Run as the migrator role (BYPASSRLS) so the dump sees all rows.
#
# Verify a dump before trusting it:
#   pg_restore --list backups/flowwise-<stamp>.dump | head
set -eu

: "${DATABASE_URL:?DATABASE_URL is required (connection string of the database to back up)}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="${1:-backups/flowwise-${stamp}.dump}"
mkdir -p "$(dirname "$out")"

pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --file="$out"

echo "Backup written to $out ($(wc -c <"$out" | tr -d ' ') bytes)"
echo "Verify: pg_restore --list $out | head"
