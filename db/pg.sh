#!/usr/bin/env bash
# Локальный PostgreSQL для тестов: поднять, остановить, проверить.
# Контейнер сессии может перезапуститься и погасить сервер, поэтому
# ./db/pg.sh start безопасно вызывать повторно.
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA="${PGDATA:-/var/lib/postgresql/partner-test}"
PORT="${PGPORT:-55432}"

case "${1:-start}" in
  start)
    if psql -h /tmp -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1; then
      echo "postgres уже слушает порт $PORT"; exit 0
    fi
    if [ ! -d "$PGDATA/base" ]; then
      rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown -R postgres:postgres "$PGDATA"
      su postgres -c "PATH=$PGBIN:\$PATH initdb -D $PGDATA -A trust -U postgres" >/dev/null
      echo "кластер создан"
    fi
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA -o '-p $PORT -k /tmp' -l $PGDATA/log start -w" >/dev/null
    echo "postgres поднят на порту $PORT"
    ;;
  stop)
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop -w" >/dev/null && echo "остановлен"
    ;;
  status)
    psql -h /tmp -p "$PORT" -U postgres -tAc 'select version()' 2>&1 | head -1
    ;;
  *)
    echo "использование: $0 {start|stop|status}" >&2; exit 2
    ;;
esac
