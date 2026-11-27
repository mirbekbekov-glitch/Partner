"""Тёмная версия рисунка первого экрана из светлой.

    python3 tools/make-hero-dark.py

Читает public/hero-stairs.webp и пишет public/hero-stairs-dark.webp.
Запускать заново нужно только если заменили светлый файл.

Деление проходит не по цвету, а по предмету: лист отдельно, лестница
отдельно. Две попытки сделать это по цвету провалились — сплошная
инверсия переворачивает и красный (тёмная тень становится светлым
бликом, объём читается наизнанку), а порог по насыщенности даёт шум,
потому что у почти белой бумаги насыщенность скачет: знаменатель в
формуле HSL там стремится к нулю.

Здесь маска объекта строится размыканием (тонкие линии чертежа
отсеиваются, лестница остаётся) и заливкой дыр от краёв листа — так
светлые проступи ВНУТРИ лестницы остаются объектом. Затем лист
переворачивается по светлоте, а лестница остаётся как была.
"""
import numpy as np
from PIL import Image, ImageFilter

src = Image.open('/home/user/Partner/public/hero-stairs.webp').convert('RGB')
a = np.asarray(src).astype(np.float32)/255.0
mx, mn = a.max(2), a.min(2)
l = (mx+mn)/2
chroma = mx-mn

obj = ((chroma > 0.10) | (l < 0.86))
m = Image.fromarray((obj*255).astype(np.uint8), 'L')
# Размыкание: тонкие линии чертежа уходят, лестница остаётся.
m = m.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
obj = np.asarray(m) > 127

# Заливка дыр: всё, что не объект и не связано с краем листа, —
# это светлые проступи и панели ВНУТРИ лестницы, и они остаются.
free = ~obj
seed = np.zeros_like(free)
seed[0,:]=free[0,:]; seed[-1,:]=free[-1,:]; seed[:,0]=free[:,0]; seed[:,-1]=free[:,-1]
prev = -1
while seed.sum() != prev:
    prev = seed.sum()
    d = seed.copy()
    d[1:,:] |= seed[:-1,:]; d[:-1,:] |= seed[1:,:]
    d[:,1:] |= seed[:,:-1]; d[:,:-1] |= seed[:,1:]
    seed = d & free
solid = ~seed                      # объект вместе с заращёнными дырами

m = Image.fromarray((solid*255).astype(np.uint8), 'L')
m = m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.8))
w = (np.asarray(m).astype(np.float32)/255.0)[...,None]

grey = a.mean(2)
bg = np.clip(np.repeat((1.0-grey)[...,None], 3, 2)*0.92, 0, 1)
out = np.clip(w*a + (1-w)*bg, 0, 1)
Image.fromarray((out*255).astype(np.uint8)).save('/home/user/Partner/public/hero-stairs-dark.webp', quality=90, method=6)
print('saved; доля объекта', round(float(solid.mean()),3))
