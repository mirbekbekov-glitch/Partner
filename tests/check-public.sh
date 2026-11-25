#!/usr/bin/env bash
# Что публичная часть читает из базы.
#
# Витрина — единственный источник, которому разрешено питать открытые
# страницы: в ней нет ни комиссии, ни агента, ни собственника.
#
# Раньше правило звучало так: публичный файл читает только представление
# public_catalog_v. Теперь витрина — это модуль lib/db/catalog.ts, и
# правило стало строже: публичная страница не вправе обратиться к базе
# НИКАК, кроме как через него. Обращение к lib/db/sql напрямую означало бы
# свой запрос со своим списком колонок — ровно то, от чего витрина и
# защищает.
#
# Сам состав витрины проверяется прогоном tests/d1: там есть проверка, что
# в выдаче нет ни агента, ни комиссии, ни контактов, и рядом — что в самой
# таблице эти колонки есть, иначе проверка была бы пустой.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Публичные страницы: всё в app/, кроме кабинета, входа, auth и api.
mapfile -t PUB < <(find "$ROOT/app" -name '*.tsx' -o -name '*.ts' \
  | grep -v '/app/cabinet/' | grep -v '/app/login/' \
  | grep -v '/app/auth/' | grep -v '/app/api/' | sort)

# Модули слоя доступа, которые публичной части разрешены.
ALLOWED='lib/db/catalog|lib/db/leads|lib/db/requests|lib/db/errors|lib/db/money|lib/db/normalize'

bad=0
for f in "${PUB[@]}"; do
  rel="${f#"$ROOT"/}"

  # Прямое обращение к базе мимо витрины.
  if grep -qE "from '@/lib/db/sql'" "$f"; then
    echo "  ЗАПРЕЩЕНО    $rel обращается к базе напрямую, мимо витрины"
    bad=$((bad+1))
    continue
  fi

  # Какие модули слоя доступа читает файл.
  mods="$(grep -oE "from '@/lib/db/[a-z-]+'" "$f" | sed "s|from '@/||;s|'||" | sort -u)"
  for m in $mods; do
    if ! echo "$m" | grep -qE "^($ALLOWED)$"; then
      echo "  ЗАПРЕЩЕНО    $rel читает $m — он не для публичной части"
      bad=$((bad+1))
    fi
  done
done

# Кабинетные таблицы не должны упоминаться в публичных файлах вовсе.
for t in deals mandates matches audit_log agents; do
  hits="$(grep -rln "from $t\b\|from \"$t\"\|'$t'" "${PUB[@]}" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "  ВНИМАНИЕ     упоминание таблицы $t в публичных файлах:"
    echo "$hits" | sed "s|^$ROOT/|               |"
  fi
done

if [ "$bad" -gt 0 ]; then
  echo
  echo "  публичная часть читает не только витрину: $bad нарушений"
  exit 1
fi

echo "  публичная часть читает только витрину"
