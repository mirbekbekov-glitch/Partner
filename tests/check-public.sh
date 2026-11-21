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
  # Вызовы функций базы: публичной части разрешена ровно одна — приём
  # заявки. Остальные считают комиссию, публикуют объекты и одобряют
  # агентов, и в открытой части им делать нечего.
  for fn in $(grep -o "\.rpc('[a-z_]*'" "$f" | sed "s/\.rpc('//;s/'//"); do
    if [ "$fn" != "submit_lead" ]; then
      echo "  ЗАПРЕЩЕНО    $rel вызывает rpc('$fn') — публичной части разрешён только submit_lead"
      bad=$((bad+1))
    else
      echo "  ok           $rel → rpc('submit_lead')"
    fi
  done
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
# словаре, посетитель увидит английское слово, а фильтр этот вид потеряет.
# Проверяем КАЖДЫЙ язык: пропущенный вид в китайском словаре так же ломает
# выдачу, как пропущенный в русском, но заметить его некому.
if [ -n "${DB:-}" ]; then
  db_kinds="$(psql -X -q -t -A -d "$DB" -c "
    select string_agg(e.enumlabel, ' ' order by e.enumlabel)
      from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'object_kind'" 2>/dev/null)"
  for lang in ky ru en zh; do
    # Ключи из блока kinds именно этого словаря.
    ts_kinds="$(sed -n "/^const $lang: Dict = {/,/^};/p" "$ROOT/lib/i18n.ts" \
      | sed -n '/kinds: {/,/},/p' \
      | grep -oE "[a-z_]+: '" | sed "s/: '//" | sort | tr '\n' ' ' | sed 's/ $//')"
    if [ -n "$db_kinds" ] && [ "$db_kinds" != "$ts_kinds" ]; then
      echo "  ЗАПРЕЩЕНО    словарь «$lang» разошёлся с перечислением object_kind"
      echo "                 в базе: $db_kinds"
      echo "                 в коде: $ts_kinds"
      bad=$((bad+1))
    else
      echo "  ok           словарь «$lang» покрывает object_kind целиком"
    fi
  done
fi

# --- каждая подпись интерфейса переведена на все четыре языка ---------------
# Пропущенное поле typescript поймает сам — тип Dict обязателен. А вот
# подпись, оставленную на русском в английском словаре, не поймает никто,
# поэтому проверяем хотя бы отсутствие кириллицы там, где её быть не может.
# Диапазон задан кодами: класс вида [А-Яа-я] в grep -E сравнивает байты и
# ловит заодно китайский, из-за чего проверка срабатывала всегда.
for lang in en zh; do
  cyr="$(sed -n "/^const $lang: Dict = {/,/^};/p" "$ROOT/lib/i18n.ts" \
    | grep -nP "(*UTF)'[^']*[\x{0400}-\x{04FF}]" || true)"
  if [ -n "$cyr" ]; then
    echo "  ЗАПРЕЩЕНО    в словаре «$lang» осталась кириллица:"
    echo "$cyr" | sed 's/^/                 /'
    bad=$((bad+1))
  else
    echo "  ok           словарь «$lang» без кириллицы"
  fi
done

echo ""
if [ "$bad" -gt 0 ]; then
  echo "публичная часть видит лишнее: $bad"
  exit 1
fi
echo "  публичные страницы читают только public_catalog_v"

