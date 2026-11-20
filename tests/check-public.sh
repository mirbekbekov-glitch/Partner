#!/usr/bin/env bash
# Что публичная часть читает из базы.
#
# Витрина public_catalog_v — единственный источник, которому разрешено
# питать открытые страницы: в ней нет ни комиссии, ни агента, ни
# собственника. Стоит публичной странице обратиться к таблице напрямую,
# и наружу поедет то, чего там быть не должно, — а RLS этого не остановит:
# objects анониму открыты политикой каталога, и среди колонок есть
# created_by_agent_id.
#
# Поэтому правило структурное: публичные файлы читают ТОЛЬКО витрину.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Публичные страницы: всё в app/, кроме кабинета, входа, auth и api.
mapfile -t PUB < <(find "$ROOT/app" -name '*.tsx' -o -name '*.ts' \
  | grep -v '/app/cabinet/' | grep -v '/app/login/' \
  | grep -v '/app/auth/' | grep -v '/app/api/' | sort)

bad=0
for f in "${PUB[@]}"; do
  rel="${f#"$ROOT"/}"
  # Какие источники читает файл.
  srcs="$(grep -o "\.from('[a-z_]*')" "$f" | sed "s/\.from('//;s/')//" | sort -u)"
  for s in $srcs; do
    if [ "$s" != "public_catalog_v" ]; then
      echo "  ЗАПРЕЩЕНО    $rel читает «$s» — публичной части положена только витрина"
      bad=$((bad+1))
    fi
  done
  # Вызовы функций базы с публичной страницы тоже запрещены: среди них есть
  # такие, что считают комиссию.
  if grep -q '\.rpc(' "$f"; then
    echo "  ЗАПРЕЩЕНО    $rel вызывает rpc() — публичной части это не нужно"
    bad=$((bad+1))
  fi
  [ -n "$srcs" ] && echo "  ok           $rel → $srcs"
done

# Колонки, которых в публичной части быть не может. Проверяем по именам
# полей витрины: если имя появилось в публичном файле, значит данные взяты
# не из неё.
FORBIDDEN='commission_total|commission_|listing_agent|closing_agent|owner_agent|created_by_agent_id|contact_phones|phone_normalized'
for f in "${PUB[@]}"; do
  if grep -nE "$FORBIDDEN" "$f" >/dev/null; then
    echo "  ЗАПРЕЩЕНО    ${f#"$ROOT"/} упоминает закрытое поле:"
    grep -nE "$FORBIDDEN" "$f" | sed 's/^/                 /'
    bad=$((bad+1))
  fi
done


# --- список типов объектов не должен разъезжаться со схемой -----------------
# Витрина отдаёт kind как есть. Если в базе появился вид, которого нет в
# KIND_RU, посетитель увидит английское слово, а фильтр этот вид потеряет.
if [ -n "${DB:-}" ]; then
  db_kinds="$(psql -X -q -t -A -d "$DB" -c "
    select string_agg(e.enumlabel, ' ' order by e.enumlabel)
      from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'object_kind'" 2>/dev/null)"
  # Только ключи из блока KIND_RU, а не любые поля объектов в файле.
  ts_kinds="$(sed -n '/export const KIND_RU/,/^};/p' "$ROOT/lib/catalog-params.ts" \
    | grep -oE '^  [a-z]+:' | tr -d ' :' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$db_kinds" ] && [ "$db_kinds" != "$ts_kinds" ]; then
    echo "  ЗАПРЕЩЕНО    KIND_RU разошёлся с перечислением object_kind"
    echo "                 в базе: $db_kinds"
    echo "                 в коде: $ts_kinds"
    bad=$((bad+1))
  else
    echo "  ok           KIND_RU покрывает object_kind целиком"
  fi
fi

echo ""
if [ "$bad" -gt 0 ]; then
  echo "публичная часть видит лишнее: $bad"
  exit 1
fi
echo "  публичные страницы читают только public_catalog_v"

