#!/usr/bin/env bash
# Puts a backup back as the live database: after losing the server (on the new one, once it runs), or
# after a mistake. Everything written to the database since that backup is lost, so it asks first, and it
# keeps a dump of the database as it was in /var/lib/ystara-backup before replacing it.
#   sudo /opt/ystara/deploy/restore.sh                 the latest backup
#   sudo /opt/ystara/deploy/restore.sh <snapshot ID>   another one: `restic snapshots` lists them
# The restored database opens its secrets only with the master key it was made with: put that key in
# /etc/ystara/secrets/master_key first (deploy/README.md, "Restore after losing the server").
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck source=/dev/null
. "${YSTARA_BACKUP_SETTINGS:-/etc/ystara/backup.env}"
set +a

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
restic snapshots --tag ystara --host ystara --compact
restic restore "${1:-latest}" --tag ystara --host ystara --target "$work"
dump="$(find "$work" -name ystara.dump -type f | head -n 1)"
if [ -z "$dump" ]; then
  echo "That backup holds no ystara.dump." >&2
  exit 1
fi

if [ "${YSTARA_RESTORE_CONFIRMED:-}" != "yes" ]; then
  read -r -p "Replace the live database with backup ${1:-latest}? Everything since is lost. Type restore: " answer
  [ "$answer" = "restore" ] || { echo "Nothing changed."; exit 1; }
fi

kept="${YSTARA_BACKUP_DIR:-/var/lib/ystara-backup}/before-restore-$(date +%Y%m%d-%H%M%S).dump"
install -d -m 700 "$(dirname "$kept")"
"$here/compose" up -d postgres
for _ in $(seq 1 60); do
  if "$here/compose" exec -T postgres pg_isready -q -h 127.0.0.1 -U ystara -d ystara; then break; fi
  sleep 1
done
"$here/compose" exec -T postgres pg_dump --username ystara --dbname ystara --format custom --no-owner > "$kept"
echo "The database as it was: $kept"

# Nothing may write while the database is replaced.
"$here/compose" stop api worker
"$here/compose" exec -T postgres psql -U ystara -d postgres -v ON_ERROR_STOP=1 -c "drop database ystara with (force)" -c "create database ystara owner ystara"
"$here/compose" exec -T postgres pg_restore --username ystara --dbname ystara --no-owner --exit-on-error < "$dump"
# migrate applies any migration newer than the backup, then the API and worker start again, on the images
# already built: a restore shouldn't wait for (or fail on) a build.
"$here/compose" up -d --no-build
echo "Restored. Sign in and check the latest tenants, pipelines and audit log entries."
