#!/usr/bin/env bash
# Сверка вызовов rpc() из кода кабинета со схемой базы.
#
# PostgREST отдаёт только функции из схемы public. Функция, оставленная в
# app, компилируется, проходит SQL-тесты и падает лишь в рантайме — такую
# ошибку я уже делал дважды. Этот скрипт ловит её до запуска.
set -uo pipefail

PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-55432}"; PGUSER="${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DB:-partner}"

all_calls="$(grep -rhoE "rpc\([^)]{0,40}" "$ROOT/app" "$ROOT/lib" 2>/dev/null | wc -l)"
names="$(grep -rhoE "rpc\(\s*'[a-z0-9_]+'" "$ROOT/app" "$ROOT/lib" 2>/dev/null \
  | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u)"
literal_calls="$(grep -rhoE "rpc\(\s*'[a-z0-9_]+'" "$ROOT/app" "$ROOT/lib" 2>/dev/null | wc -l)"

fail=0

# Имя, переданное переменной, этот скрипт не видит — а значит и не проверит.
# Такой вызов должен сломать сверку, иначе смысл её теряется.
if [ "$all_calls" -ne "$literal_calls" ]; then
  echo "  ВНИМАНИЕ     вызовов rpc(): $all_calls, из них с буквальным именем: $literal_calls"
  echo "               имя функции надо писать буквально, иначе сверка его пропустит:"
  grep -rnE "rpc\(" "$ROOT/app" "$ROOT/lib" 2>/dev/null \
    | grep -vE "rpc\(\s*'[a-z0-9_]+'" | sed 's|^'"$ROOT"'/|               |'
  fail=$((fail+1))
fi

if [ -z "$names" ]; then
  echo "вызовов rpc() с буквальным именем не найдено"
  [ "$fail" -gt 0 ] && exit 1
  exit 0
fi
while read -r fn; do
  [ -z "$fn" ] && continue
  ok="$(psql -tA -d "$DB" -c "
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '$fn'
       and has_function_privilege('authenticated', p.oid, 'execute')" 2>/dev/null)"
  if [ "${ok:-0}" = "0" ]; then
    echo "  ОТСУТСТВУЕТ  $fn — нет в public или не выдан execute роли authenticated"
    fail=$((fail+1))
  else
    echo "  ok           $fn"
  fi
done <<< "$names"

echo ""
if [ "$fail" -gt 0 ]; then
  echo "сверка не прошла: $fail — кабинет упадёт в рантайме"
  exit 1
fi
echo "все вызовы rpc() доступны через PostgREST"
