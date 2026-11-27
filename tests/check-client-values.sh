#!/usr/bin/env bash
# Серверный компонент не читает значения из модуля 'use client'.
#
# Импортировать клиентский КОМПОНЕНТ в серверный — обычное дело, на этом
# всё и держится. Но импортировать оттуда простой объект нельзя: сервер
# получает не значение, а ссылку на клиентский модуль. Чтение поля такой
# ссылки молча отдаёт undefined — а если имя поля совпало с методом
# функции, то и вовсе что-то постороннее.
#
# Так и случилось: KIND_RU жил в Activities.tsx с 'use client', страница
# задач читала KIND_RU[kind], и на незакрытом ЗВОНКЕ запрос падал с 500 —
# KIND_RU['call'] отдавал Function.prototype.call, а React встречал
# функцию там, где ждал текст. Остальные виды записей тихо отдавали
# undefined, и подстановка ?? прятала поломку за английским словом.
#
# Проверка смотрит, как используется импортированное имя: в разметке
# (<Имя ...>) — можно, где угодно ещё — нельзя.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import re, sys, os, glob
root = sys.argv[1]

def strip_comments(s):
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'(?m)^\s*//[^\n]*$', '', s)

files = [f for f in glob.glob(os.path.join(root, '**/*.ts*'), recursive=True)
         if '/node_modules/' not in f and '/.test-build/' not in f]
src = {f: strip_comments(open(f, encoding='utf-8').read()) for f in files}

def is_client(path):
    head = src.get(path, '')[:400]
    return "'use client'" in head or '"use client"' in head

def resolve(importer, spec):
    if spec.startswith('@/'):
        base = os.path.join(root, spec[2:])
    elif spec.startswith('.'):
        base = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    else:
        return None
    for cand in (base + '.tsx', base + '.ts',
                 os.path.join(base, 'index.tsx'), os.path.join(base, 'index.ts')):
        if cand in src:
            return cand
    return None

IMPORT = re.compile(r"import\s+(type\s+)?\{([^}]*)\}\s+from\s+['\"]([^'\"]+)['\"]")
bad = []
for f, text in src.items():
    if is_client(f):
        continue
    for m in IMPORT.finditer(text):
        if m.group(1):          # import type { ... }
            continue
        target = resolve(f, m.group(3))
        if not target or not is_client(target):
            continue
        for piece in m.group(2).split(','):
            piece = piece.strip()
            if not piece or piece.startswith('type '):
                continue
            name = piece.split(' as ')[-1].strip()
            if not name:
                continue
            # Как используется: в разметке или ещё где-то.
            body = text[m.end():]
            uses = [u.start() for u in re.finditer(r'\b' + re.escape(name) + r'\b', body)]
            jsx = len(re.findall(r'<' + re.escape(name) + r'[\s/>.]', body))
            if len(uses) > jsx:
                bad.append(f'  {os.path.relpath(f, root)}: «{name}» из '
                           f'{os.path.relpath(target, root)} (\'use client\') '
                           f'читается как значение, а не ставится в разметку')

if bad:
    print('Значение из клиентского модуля в серверном компоненте:\n')
    print('\n'.join(bad))
    print('\nПеренесите такое значение в обычный модуль без \'use client\'.')
    sys.exit(1)
print('  серверные компоненты берут из клиентских только разметку')
PY
