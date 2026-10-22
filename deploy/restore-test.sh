#!/usr/bin/env bash
# Proves that a backup can be put back. Reads a tenth of the stored backup data back (restic check), then
# restores the latest backup (or the one named) into a throwaway Postgres container with no network, checks
# that Ystara's tables are there, and prints their rows next to the live database's. The container and the
# restored file are deleted after; nothing live is touched.
# Weekly by systemd (deploy/systemd/ystara-restore-test.timer), or by hand:
#   sudo /opt/ystara/deploy/restore-test.sh [snapshot ID]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck source=/dev/null
. "${YSTARA_BACKUP_SETTINGS:-/etc/ystara/backup.env}"
set +a

ping() { if [ -n "${YSTARA_BACKUP_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 -o /dev/null "$YSTARA_BACKUP_PING_URL$1" || true; fi; }
work="$(mktemp -d)"
box="ystara-restore-test-$$"
cleanup() {
  docker rm -f "$box" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'ping /fail' ERR

restic check --read-data-subset=10%
restic restore "${1:-latest}" --tag ystara --host ystara --target "$work"
dump="$(find "$work" -name ystara.dump -type f | head -n 1)"
if [ -z "$dump" ]; then
  echo "That backup holds no ystara.dump." >&2
  false
fi

# The same Postgres as the live one, so the dump restores as it would after losing the server.
image="$(docker inspect --format '{{.Config.Image}}' "$("$here/compose" ps -q postgres)")"
docker run -d --name "$box" --network none -e POSTGRES_USER=ystara -e POSTGRES_DB=ystara -e POSTGRES_PASSWORD=restore-test "$image" > /dev/null
# Over TCP: the first server Postgres starts while it sets up listens on its socket only.
for _ in $(seq 1 60); do
  if docker exec "$box" pg_isready -q -h 127.0.0.1 -U ystara -d ystara; then break; fi
  sleep 1
done
docker exec -i "$box" pg_restore --username ystara --dbname ystara --no-owner --exit-on-error < "$dump"

restored() { docker exec "$box" psql -U ystara -d ystara -At -c "$1"; }
live() { "$here/compose" exec -T postgres psql -U ystara -d ystara -At -c "$1"; }
migrations="$(restored "select count(*) from schema_migrations")"
if [ "$migrations" -lt 1 ]; then
  echo "The restored database has no migrations: it is not Ystara's." >&2
  false
fi
printf '%-16s %10s %10s\n' table restored live
for table in schema_migrations accounts users tenants scans pipelines snapshots scenario_runs audit_events; do
  printf '%-16s %10s %10s\n' "$table" "$(restored "select count(*) from $table")" "$(live "select count(*) from $table" 2> /dev/null || echo "?")"
done

ping ""
echo "Restore test passed."
