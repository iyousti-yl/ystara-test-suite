# Hosting Ystara: the runbook

How to run Ystara for customers on one server in the EU, with HTTPS, nightly encrypted backups off the server and a weekly restore test. Everything here runs with `sudo` on the server, from the checkout in `/opt/ystara`.

```
 browser ──https──► Caddy (80, 443) ──► API + web app ──► Postgres
                     certificate from        │              ▲
                     Let's Encrypt           ▼              │ pg_dump, nightly
                                          worker ──► Datasphere (read-only), mail server, Teams
                                                            │
                                     restic, encrypted ─────┴──► object storage (EU, other provider)
```

Only Caddy is reachable from outside. Postgres and the API publish no port; the worker only calls out.

## What to buy first

- **A server in the EU**: Ubuntu 24.04 LTS, 2 to 4 vCPU, 8 GB RAM, 80 GB disk. For example Hetzner Cloud (Germany or Finland) or Scaleway (France). One small server is enough for the first customers (architecture decision 7).
- **A domain or subdomain** for the app, such as `app.<your domain>`.
- **Object storage** (S3-compatible) in the EU, **at another provider than the server**, for the backups. For example Scaleway Object Storage if the server is at Hetzner, or the other way round.
- **A mail service** that sends from your domain over SMTP (for alert emails), with SPF and DKIM set up in your DNS as it explains. Without one, alerts are shown in the app and posted in Teams, but not emailed.
- **A password manager** entry for Ystara's server keys (step 5): the master key and the backup password must survive the server.

## First setup

**1. Server basics.** Sign in with an SSH key, as a user with sudo, not as root.

```bash
sudo timedatectl set-timezone Europe/Brussels
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades ufw git restic curl
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
```

In `/etc/ssh/sshd_config`, set `PasswordAuthentication no` and `PermitRootLogin no`, then `sudo systemctl reload ssh`.

Docker publishes container ports past ufw. That is why only Caddy has `ports:` in `deploy/docker-compose.prod.yml`, and a test (`packages/shared/src/env.test.ts`) fails if another service gets one.

**2. DNS.** Point an A record (and AAAA, for IPv6) of `app.<your domain>` at the server. Let's Encrypt checks it at the first start.

**3. Docker and the code.** Install Docker Engine with its Compose plugin from Docker's own apt repository (docs.docker.com/engine/install/ubuntu). Ubuntu's own `docker.io` package is too old for `!override` and `!reset` in the compose file, which need Compose 2.24.4 or newer. Then:

```bash
sudo git clone https://github.com/iyousti-yl/ystara-test-suite.git /opt/ystara
```

The repository is private, so use a read-only deploy key: GitHub › the repository › Settings › Deploy keys.

**4. Settings.**

```bash
sudo install -d -m 755 /etc/ystara
sudo cp /opt/ystara/deploy/ystara.env.example /etc/ystara/ystara.env
sudo nano /etc/ystara/ystara.env   # the domain, Let's Encrypt's email, the alert sender
```

**5. Secrets.** Each is a file in `/etc/ystara/secrets`. The folder is root's only (700), and the files are 444 so the containers' users can read the ones mounted into them.

```bash
sudo install -d -m 700 /etc/ystara/secrets
cd /etc/ystara/secrets
sudo sh -c 'openssl rand -base64 32 > master_key'
sudo sh -c 'openssl rand -hex 24 > db_password'
sudo sh -c 'printf "postgres://ystara:%s@postgres:5432/ystara\n" "$(cat db_password)" > database_url'
sudo sh -c 'printf "%s\n" "smtp://<user>:<password>@<mail server>:587" > smtp_url'   # or leave the file empty
sudo sh -c 'openssl rand -base64 32 > restic_password'
sudo chmod 444 master_key db_password database_url smtp_url && sudo chmod 400 restic_password
```

In `smtp_url`, write a `@`, `:` or `/` inside the user or password as `%40`, `%3A` or `%2F`. Use `smtps://...:465` if the mail service asks for port 465.

**Copy `master_key` and `restic_password` into the password manager now**, apart from the server.
- `master_key` seals every secret in the database: authenticator secrets, tenants' client secrets, database user passwords and Teams addresses. Without it a restored database opens none of them: every user sets up their authenticator again and every tenant is connected again.
- `restic_password` opens the backups. Without it no backup can be read.

Neither is in the backups, on purpose.

**6. First start.**

```bash
sudo /opt/ystara/deploy/compose up -d --build
curl https://app.<your domain>/api/health   # {"status":"ok",...}
```

The first build takes a few minutes. Then create the first account and make yourself the operator:

```bash
sudo /opt/ystara/deploy/compose run --rm tools npm run account:create -- --name "<Customer>" --admin <their admin's email>
sudo /opt/ystara/deploy/compose run --rm tools npm run operator:grant -- --email <your email>
```

`account:create` prints an invitation link (`https://app.<your domain>/invite/...`). Open it yourself for your own account, or send it to the customer's admin. `operator:grant` needs a user that already exists, so accept your own invitation first.

**7. Backups.**

```bash
sudo cp /opt/ystara/deploy/backup.env.example /etc/ystara/backup.env && sudo chmod 600 /etc/ystara/backup.env
sudo nano /etc/ystara/backup.env   # the bucket address and its keys
sudo sh -c 'set -a; . /etc/ystara/backup.env; restic init'
sudo cp /opt/ystara/deploy/systemd/ystara-* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ystara-backup.timer ystara-restore-test.timer
sudo systemctl start ystara-backup.service && sudo systemctl start ystara-restore-test.service
sudo journalctl -u ystara-backup -u ystara-restore-test --since today   # "Backup done", "Restore test passed."
```

The backup runs every night at 03:30. It keeps one backup a day for 14 days, one a week for 8 weeks and one a month for 6 months. The restore test runs every Sunday at 05:00.

**8. Being told when something stops.** Two free checks are enough to start:
- An uptime check on `https://app.<your domain>/api/health` (any uptime service).
- A ping check for the backups (healthchecks.io or similar). Put its URL in `YSTARA_BACKUP_PING_URL`. Each successful backup and restore test calls it, a failure calls it with `/fail`, and the service emails you when the calls stop.

## Day to day

| What | How |
|---|---|
| **Update** to the latest `main` | `cd /opt/ystara && sudo git pull && sudo deploy/backup.sh && sudo deploy/compose up -d --build`. Migrations run on their own (the `migrate` service), before the API and worker start. Expect a few seconds of downtime. |
| **Go back** to an earlier version | `sudo git checkout <commit> && sudo deploy/compose up -d --build`. A migration is never undone. If the newer version changed the database, restore the backup taken before the update (`deploy/restore.sh <snapshot>`). |
| **See what runs** | `sudo deploy/compose ps`, and `systemctl list-timers 'ystara-*'` |
| **Logs** | `sudo deploy/compose logs -f --since 1h api worker`. Logs rotate on their own (5 files of 20 MB per service). |
| **List backups** | `sudo sh -c 'set -a; . /etc/ystara/backup.env; restic snapshots'` |
| **Restore test by hand** | `sudo deploy/restore-test.sh`, or `sudo deploy/restore-test.sh <snapshot>` |
| **Undo a mistake** (a deleted tenant, say) | `sudo deploy/restore.sh <snapshot>`. It asks first, keeps the database as it was in `/var/lib/ystara-backup/`, and puts the backup back. Everything since that backup is lost, for every account. |
| **Change the mail server** | Edit `/etc/ystara/secrets/smtp_url`, then `sudo deploy/compose up -d --force-recreate worker` |
| **Admin commands** | `sudo deploy/compose run --rm tools npm run <account:create, operator:grant> -- ...` |
| **Disk space** | `docker system df`. After updates, `sudo docker image prune` removes old images. |

Never change `master_key`: Ystara can't re-seal its secrets with a new key yet.

## Restore after losing the server

1. Take a new server and follow steps 1 to 5. In step 5, take `master_key` and `restic_password` from the password manager instead of making new ones. Make a new `db_password` and `database_url`.
2. Step 6, the first start, without creating accounts.
3. Step 7, with the same bucket and keys in `backup.env`, without `restic init`. Then `sudo /opt/ystara/deploy/restore.sh` (the latest backup).
4. If the server's address changed, update the DNS record. Caddy gets a new certificate on its own.
5. Sign in and check the latest tenants, pipelines and audit log entries.

## Trying it on your own machine

The same files run locally, with a certificate Caddy makes for `localhost` (on Windows, in Git Bash or WSL):

```bash
mkdir -p ~/ystara-trial/secrets   # make the four container secrets there as in step 5
printf 'YSTARA_DOMAIN=localhost\nYSTARA_ACME_EMAIL=you@example.com\nYSTARA_SMTP_FROM=Ystara <alerts@example.com>\n' > ~/ystara-trial/ystara.env
export YSTARA_SETTINGS=~/ystara-trial/ystara.env YSTARA_SECRETS=~/ystara-trial/secrets
deploy/compose up -d --build && curl -k https://localhost/api/health
deploy/compose down -v   # afterwards: removes the trial's containers and data
```

For backups, point `YSTARA_BACKUP_SETTINGS` at a `backup.env` whose `RESTIC_REPOSITORY` is a local folder.

## What this doesn't do yet

- One server, so it is down while it restarts or is updated (seconds), or if it fails (until restored).
- The image is built on the server from the checkout. There is no image registry and no deployment from CI.
- No metrics or log search: only the logs on the server, an uptime check and the backup pings.
- The server's own disk isn't backed up. Everything that matters is in the database, and the files in `/etc/ystara` are in the password manager or easy to make again.
