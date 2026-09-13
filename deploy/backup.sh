#!/usr/bin/env bash
# Резервная копия базы бота.
#
# Важно: база работает в режиме WAL, поэтому простое копирование файла .db
# может дать неполный снимок (часть данных лежит в .db-wal).
# Команда `sqlite3 .backup` делает согласованную копию на работающем боте.
#
# Установка в cron (ежедневно в 04:00):
#   sudo crontab -u vpnbot -e
#   0 4 * * * /opt/vpnbot/deploy/backup.sh

set -euo pipefail

DB="${DB_FILE:-/opt/vpnbot/data/bot.db}"
DEST="${BACKUP_DIR:-/opt/vpnbot/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUT="$DEST/bot-$STAMP.db"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Нужен sqlite3: sudo apt install -y sqlite3" >&2
  exit 1
fi

# .backup корректно работает с WAL и не требует остановки бота.
sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
echo "Копия готова: $OUT.gz"

# Чистим старые копии.
find "$DEST" -name 'bot-*.db.gz' -mtime "+$KEEP_DAYS" -delete
echo "Удалены копии старше $KEEP_DAYS дней."
