#!/usr/bin/env bash
# Пересобирает локальную базу с нуля: стаб Supabase + все миграции по порядку.
# Нужен, чтобы миграции проверялись на чистой базе, а не на остатках прошлого прогона.
set -euo pipefail

PGHOST="${PGHOST:-/tmp}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
DB="${DB:-partner}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGHOST PGPORT PGUSER

psql -q -d postgres -c "drop database if exists ${DB} with (force)" >/dev/null
psql -q -d postgres -c "create database ${DB}" >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null; }

run "$ROOT/db/local_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '  migrate %s\n' "$(basename "$f")"
  run "$f"
done
echo "  база ${DB} пересобрана"
