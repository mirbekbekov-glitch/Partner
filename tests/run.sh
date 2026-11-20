#!/usr/bin/env bash
# Прогон тестов инвариантов.
#
# Каждый тест получает СВОЮ базу, созданную из шаблона: тесты не видят друг
# друга и порядок запуска ничего не меняет.
set -uo pipefail

PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-55432}"; PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL=partner_tpl

say() { printf '%s\n' "$*"; }

# --- шаблон -----------------------------------------------------------------
psql -q -d postgres -c "drop database if exists ${TPL} with (force)" >/dev/null
psql -q -d postgres -c "create database ${TPL}" >/dev/null
for f in "$ROOT/db/local_supabase_stub.sql" "$ROOT"/supabase/migrations/*.sql \
         "$ROOT/tests/harness.sql" "$ROOT/tests/seed.sql"; do
  if ! psql -q -v ON_ERROR_STOP=1 -d "$TPL" -f "$f" >/tmp/tpl.log 2>&1; then
    say "НЕ УДАЛОСЬ СОБРАТЬ ШАБЛОН на $(basename "$f"):"; cat /tmp/tpl.log; exit 1
  fi
done
say "шаблон собран: миграции + харнесс + сценарий приёмки"
say ""

# --- тесты ------------------------------------------------------------------
pass=0; fail=0; failed_names=()
shopt -s nullglob
files=("$ROOT"/tests/invariants/*.sql "$ROOT"/tests/acceptance*.sql)
[ "$#" -gt 0 ] && files=("$@")

for f in "${files[@]}"; do
  name="$(basename "$f" .sql)"
  db="t_$(echo "$name" | tr -cd 'a-z0-9_')"
  psql -q -d postgres -c "drop database if exists ${db} with (force)" >/dev/null 2>&1
  psql -q -d postgres -c "create database ${db} template ${TPL}" >/dev/null 2>&1

  say "── ${name}"
  out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" 2>&1)"
  rc=$?
  # NOTICE от test.ok — это и есть отчёт о пройденных утверждениях.
  printf '%s\n' "$out" | sed -n "s/^.*NOTICE:  //p"
  if [ $rc -eq 0 ]; then
    say "   ПРОЙДЕН"; pass=$((pass+1))
  else
    printf '%s\n' "$out" | grep -E 'ERROR:' | sed 's/^.*ERROR:/   ERROR:/'
    say "   ПРОВАЛЕН"; fail=$((fail+1)); failed_names+=("$name")
  fi
  psql -q -d postgres -c "drop database if exists ${db} with (force)" >/dev/null 2>&1
  say ""
done

# Сверка вызовов rpc() со схемой: PostgREST видит только public, и функция,
# оставленная в app, падает лишь в рантайме. Шаблон уже собран, на нём и
# проверяем.
say "── сверка вызовов rpc() со схемой"
if DB="$TPL" "$ROOT/tests/check-rpc.sh" >/tmp/rpc.log 2>&1; then
  say "   ПРОЙДЕНА"; pass=$((pass+1))
else
  sed 's/^/   /' /tmp/rpc.log; say "   ПРОВАЛЕНА"
  fail=$((fail+1)); failed_names+=("check-rpc")
fi
say ""

say "═══════════════════════════════════════"
say "пройдено: ${pass}   провалено: ${fail}"
if [ ${fail} -gt 0 ]; then
  say "провалились: ${failed_names[*]}"
  exit 1
fi
