#!/usr/bin/env bash
# Развёртывание схемы и настройка входа на живом Supabase.
#
# Делает три вещи, каждую из которых иначе приходится делать руками:
#   1. применяет миграции;
#   2. прописывает Redirect URLs — без них ссылка из письма не вернётся в
#      приложение;
#   3. заменяет шаблон письма Magic Link на ссылку с TokenHash — без этого
#      Supabase присылает ссылку на свой /verify, и маршрут /auth/confirm
#      её не получает.
#
# Третий пункт — самая частая причина «вход не работает»: всё настроено
# верно, а письмо ведёт не туда.
#
# Нужны переменные:
#   SUPABASE_ACCESS_TOKEN  токен доступа: supabase.com/dashboard/account/tokens
#   SUPABASE_PROJECT_REF   ref проекта (из URL панели или из --list)
#   SUPABASE_DB_URL        строка подключения к базе (Settings → Database)
#   SITE_URL               адрес приложения, например http://localhost:3000
#
# Секреты не печатаются: ни в вывод, ни в сообщения об ошибках.
set -uo pipefail

API=https://api.supabase.com
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
REF="${SUPABASE_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
SITE="${SITE_URL:-http://localhost:3000}"

die() { echo "ОШИБКА: $*" >&2; exit 1; }

api() { # api METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      --data-binary "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN"
  fi
}

[ -n "$TOKEN" ] || die "нет SUPABASE_ACCESS_TOKEN — возьмите на supabase.com/dashboard/account/tokens"

# --- список проектов -------------------------------------------------------
if [ "${1:-}" = "--list" ]; then
  echo "Проекты аккаунта:"
  api GET /v1/projects | python3 -c '
import json,sys
for p in json.load(sys.stdin):
    print(f"  {p[\"id\"]}  {p[\"name\"]}  ({p.get(\"region\",\"?\")})")
'
  exit 0
fi

[ -n "$REF" ] || die "нет SUPABASE_PROJECT_REF — список проектов: $0 --list"

# --- 1. миграции -----------------------------------------------------------
if [ -n "$DB_URL" ]; then
  echo "— применяю миграции"
  npx --yes supabase db push --db-url "$DB_URL" --include-all \
    || die "миграции не применились"
else
  echo "— SUPABASE_DB_URL не задан: миграции пропущены"
  echo "  примените их сами: supabase db push --db-url ... либо вставьте"
  echo "  db/bundle.sql в SQL Editor панели"
fi

# --- 2. настройки входа ----------------------------------------------------
# Шаблон письма НЕ трогаем: на бесплатном тарифе со стандартным отправителем
# Supabase отвечает на это 400 с entitlement_required, и тогда отклоняется
# ВЕСЬ запрос — вместе с Redirect URLs. Штатному входу шаблон и не нужен:
# родное письмо ведёт на /auth/v1/verify, а тот присылает браузер на
# /auth/callback с ?code= (поток PKCE). Маршрут /auth/confirm с token_hash
# остаётся для своего шаблона, если он когда-нибудь станет доступен.

echo "— настраиваю Auth: Redirect URLs"
BODY=$(python3 - "$SITE" <<'PY'
import json, sys
site = sys.argv[1]
print(json.dumps({
    "site_url": site,
    # Оба маршрута приёма ссылки и адрес продакшена.
    "uri_allow_list": ",".join([
        f"{site}/auth/callback",
        f"{site}/auth/confirm",
        f"{site}/**",
    ]),
    "mailer_otp_exp": 3600,
}, ensure_ascii=False))
PY
)

RESP=$(api PATCH "/v1/projects/$REF/config/auth" "$BODY")
echo "$RESP" | grep -q '"error"' && { echo "$RESP" | head -3; die "настройки Auth не применились"; }

# --- проверка --------------------------------------------------------------
echo "— проверяю, что применилось"
api GET "/v1/projects/$REF/config/auth" | python3 -c '
import json,sys
c = json.load(sys.stdin)
allow = c.get("uri_allow_list") or ""
tpl = c.get("mailer_templates_magic_link_content") or ""
print("  site_url:        ", c.get("site_url"))
print("  uri_allow_list:  ", allow)
print("  /auth/callback разрешён:", "да" if "/auth/callback" in allow else "НЕТ — вход не заработает")
# Про шаблон — только справка: он нужен лишь маршруту /auth/confirm.
print("  шаблон письма:   ", "свой, с TokenHash → работает и /auth/confirm"
      if "TokenHash" in tpl else "родной Supabase → вход идёт через /auth/callback")
'

echo ""
echo "Готово. Осталось прописать в .env.local:"
echo "  NEXT_PUBLIC_SUPABASE_URL=https://$REF.supabase.co"
echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key из Settings → API>"
echo ""
echo "И завести первого админа (замените почту):"
echo "  update agents set role='admin', status='approved' where email='you@example.kg';"
