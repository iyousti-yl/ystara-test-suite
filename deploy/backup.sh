#!/usr/bin/env bash
# Backs up Ystara's database: a pg_dump, checked, then encrypted and sent off the server with restic.
# Nightly by systemd (deploy/systemd/ystara-backup.timer), or by hand: sudo /opt/ystara/deploy/backup.sh
#
# Kept: a backup a day for 14 days, one a week for 8 weeks, one a month for 6 months.
# Not in it: the master key (/etc/ystara/secrets/master_key), which stays in the password manager. The
# database's secrets are sealed with it, so a stolen backup opens none of them; and without it a restored
# database can't open them either: keep both, apart.
# YSTARA_BACKUP_SETTINGS names another settings file than /etc/ystara/backup.env (for a trial run).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck source=/dev/null
. "${YSTARA_BACKUP_SETTINGS:-/etc/ystara/backup.env}"
set +a

ping() { if [ -n "${YSTARA_BACKUP_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 -o /dev/null "$YSTARA_BACKUP_PING_URL$1" || true; fi; }
trap 'ping /fail' ERR

work="${YSTARA_BACKUP_DIR:-/var/lib/ystara-backup}"
install -d -m 700 "$work"
dump="$work/ystara.dump"
rm -f "$dump"
trap 'rm -f "$dump.part"' EXIT

# Custom format: compressed, and pg_restore can check it and restore it table by table.
"$here/compose" exec -T postgres pg_dump --username ystara --dbname ystara --format custom --no-owner > "$dump.part"
# A dump pg_restore can't read is no backup: stop here rather than store it.
"$here/compose" exec -T postgres pg_restore --list < "$dump.part" > /dev/null
mv "$dump.part" "$dump"

restic backup --tag ystara --host ystara "$dump"
restic forget --tag ystara --host ystara --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune
rm -f "$dump"

ping ""
echo "Backup done: $(restic snapshots --tag ystara --host ystara --latest 1 --compact | sed -n 3p)"
