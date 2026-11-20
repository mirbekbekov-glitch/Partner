import glob, os, sys

HEAD = """-- =====================================================================
-- Платформа профессионалов: вся схема одним файлом
--
-- Собрано из supabase/migrations/ скриптом db/bundle.sh. Этот файл нужен
-- ровно для одного случая: применить схему вручную через SQL Editor в
-- панели Supabase, когда CLI недоступен. В остальных случаях применяйте
-- миграции по отдельности: supabase db push.
--
-- Порядок файлов важен и сохранён: миграции опираются друг на друга.
-- Применять целиком, одним запуском.
--
-- Схема auth и роли anon/authenticated/service_role на Supabase уже есть,
-- поэтому db/local_supabase_stub.sql сюда НЕ включён — он только для
-- локального Postgres.
--
-- После применения обязательны две настройки в панели, без них вход не
-- работает: Redirect URLs и шаблон письма Magic Link. См. README, раздел
-- «Обязательная настройка Supabase для входа».
-- =====================================================================

"""

files = sorted(glob.glob('supabase/migrations/*.sql'))
if not files:
    sys.exit('миграции не найдены')

parts = [HEAD]
for f in files:
    name = os.path.basename(f)
    parts.append('-- ==== ' + name + ' ' + '=' * max(0, 58 - len(name)) + '\n\n')
    parts.append(open(f, encoding='utf-8').read().rstrip() + '\n\n')

out = ''.join(parts)
open('db/bundle.sql', 'w', encoding='utf-8').write(out)
print('миграций: %d, размер: %d КиБ, строк: %d'
      % (len(files), len(out) // 1024, out.count('\n')))
