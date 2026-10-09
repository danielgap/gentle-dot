#!/bin/sh
# Daily PrestaShop DB snapshot for rollback safety (gentle-dot max-power mode).
# Installed as root cron: 15 4 * * * /root/containers/gentle-dot/bin/db-dump.sh
set -eu
DEST=/home/ragarapa/web/granlenceria.es/backups-db
mkdir -p "$DEST"
chmod 700 "$DEST"
STAMP=$(date +%F-%H%M)
mariadb-dump --single-transaction --quick ragarapa_presta_b | gzip > "$DEST/presta_b-$STAMP.sql.gz"
chmod 600 "$DEST/presta_b-$STAMP.sql.gz"
# keep the newest 7 dumps
ls -1t "$DEST"/presta_b-*.sql.gz | tail -n +8 | xargs -r rm -f
