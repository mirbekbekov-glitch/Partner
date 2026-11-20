#!/usr/bin/env bash
# Где используется клиент с ключом service_role.
#
# service_role обходит RLS. Инвариант 4 (телефон собственника и клиента)
# держится именно на политиках, поэтому один импорт этого клиента в страницу
# кабинета открывает телефоны всем агентам — и ни один тест на RLS этого не
# заметит, потому что политики формально на месте.
#
# Разрешён только в app/api/** — там код действует не от имени агента.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bad=0
while read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    */app/api/*) echo "  ok           ${f#"$ROOT"/}" ;;
    */lib/supabase/service.ts) : ;;   # сам модуль
    *) echo "  ЗАПРЕЩЕНО    ${f#"$ROOT"/} — service_role вне app/api обходит RLS"
       bad=$((bad+1)) ;;
  esac
done < <(grep -rl 'createServiceClient\|SUPABASE_SERVICE_ROLE_KEY' \
           "$ROOT/app" "$ROOT/lib" 2>/dev/null || true)

echo ""
if [ "$bad" -gt 0 ]; then
  echo "service_role вне app/api: $bad — инвариант 4 обойдён"
  exit 1
fi
echo "  service_role используется только в app/api"
