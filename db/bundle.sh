#!/usr/bin/env bash
# Пересобирает db/bundle.sql из supabase/migrations/.
#
# bundle.sql нужен ровно для одного случая: применить схему вручную через
# SQL Editor панели Supabase, когда CLI недоступен. В остальных случаях
# применяйте миграции по отдельности — supabase db push.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 db/mkbundle.py
