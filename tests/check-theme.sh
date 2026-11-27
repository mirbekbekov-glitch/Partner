#!/usr/bin/env bash
# Тёмная палитра объявлена дважды — и должна совпадать.
#
# Так вышло не по небрежности: один блок стоит внутри
# @media (prefers-color-scheme: dark), второй — обычным правилом
# :root[data-theme='dark'] для тех, кто выбрал тему руками. Слить их в
# одно правило нельзя: селекторы не живут по обе стороны медиавыражения.
# Функция light-dark() избавила бы от второго блока, но на браузере, где
# её нет, токен становится невычислимым — и страница остаётся вовсе без
# цветов. Для публичного сайта это не торг.
#
# Значит, дублю быть; смертельна здесь не копия, а РАСХОЖДЕНИЕ. Правка в
# одном блоке и забытая в другом ничего не ломает в сборке и не видна в
# светлой теме: тёмная просто начинает жить своей жизнью у тех, кто
# переключил её вручную. Эта проверка такое расхождение ловит.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import re, sys, os
root = sys.argv[1]
path = os.path.join(root, 'app/globals.css')
css = open(path, encoding='utf-8').read()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)

def block(pattern, text):
    """Тело правила по его селектору: от { до парной }."""
    m = re.search(pattern, text)
    if not m:
        return None
    i = m.end()
    depth = 1
    start = i
    while i < len(text) and depth:
        if text[i] == '{': depth += 1
        elif text[i] == '}': depth -= 1
        i += 1
    return text[start:i - 1]

media = block(r"@media\s*\(prefers-color-scheme:\s*dark\)\s*\{", css)
if media is None:
    print('  НЕ НАЙДЕН блок @media (prefers-color-scheme: dark)'); sys.exit(1)
auto = block(r":root:not\(\[data-theme='light'\]\)\s*\{", media)
manual = block(r":root\[data-theme='dark'\]\s*\{", css)
if auto is None or manual is None:
    print('  НЕ НАЙДЕН один из блоков тёмной темы'); sys.exit(1)

def decls(body):
    out = {}
    for piece in body.split(';'):
        piece = piece.strip()
        if not piece or ':' not in piece:
            continue
        name, value = piece.split(':', 1)
        out[name.strip()] = ' '.join(value.split())
    return out

a, m = decls(auto), decls(manual)
bad = []
for name in sorted(set(a) | set(m)):
    if name not in a:
        bad.append(f'  только у выбранной вручную: {name}: {m[name]}')
    elif name not in m:
        bad.append(f'  только у системной:        {name}: {a[name]}')
    elif a[name] != m[name]:
        bad.append(f'  разошлись: {name} — системная «{a[name]}», вручную «{m[name]}»')

if bad:
    print('Тёмная палитра объявлена дважды, и копии разошлись:\n')
    print('\n'.join(bad))
    print('\napp/globals.css: правка в одном блоке должна повторяться во втором.')
    sys.exit(1)
print(f'  тёмная палитра: оба блока совпадают ({len(a)} объявлений)')
PY
