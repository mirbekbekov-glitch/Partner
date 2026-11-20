#!/usr/bin/env bash
# Поиск вложенных <form> в JSX.
#
# Вложенный <form> невалиден по HTML, браузеры разбирают такую разметку
# по-разному, а TypeScript и сборка её пропускают. Я такое уже написал один
# раз — в блоке собственности на карточке контакта.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import re, sys, glob, os
root = sys.argv[1]

def strip_comments(s):
    s = re.sub(r'\{/\*.*?\*/\}', '', s, flags=re.S)
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    s = re.sub(r'//[^\n]*', '', s)
    return s

bad = []
for f in sorted(glob.glob(os.path.join(root, 'app/**/*.tsx'), recursive=True)):
    s = strip_comments(open(f, encoding='utf-8').read())
    depth = 0
    for m in re.finditer(r'</form>|<form[\s>]', s):
        if m.group().startswith('</'):
            depth -= 1
        else:
            depth += 1
            if depth > 1:
                line = s[:m.start()].count('\n') + 1
                bad.append(f'  вложенный <form>  {os.path.relpath(f, root)}:{line}')
    if depth != 0:
        bad.append(f'  несбалансированные <form>  {os.path.relpath(f, root)} (depth={depth})')

if bad:
    print('\n'.join(bad))
    print(f'\nнайдено проблем: {len(bad)}')
    sys.exit(1)
print('  вложенных <form> нет')
PY
