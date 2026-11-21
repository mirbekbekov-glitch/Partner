'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Фотография объекта с запасным видом.
 *
 * Ссылки на фото вставляют агенты руками, и они протухают: хостинг закрылся,
 * файл удалили, адрес опечатан. По значку сломанной картинки посетитель
 * судит не о ссылке, а об агентстве.
 *
 * Одного onError мало, и это проверено: браузер грузит картинку из серверной
 * разметки ДО того, как React оживит страницу, и к моменту навешивания
 * обработчика событие уже прошло. Поэтому после подключения мы ещё и
 * спрашиваем саму картинку: загрузка завершена, а ширины нет — значит, не
 * вышло. Тогда показываем то же, что и у объекта без фото, — рисунок,
 * который передан сюда готовым.
 */
export function Photo({ src, fallback }: { src: string; fallback: React.ReactNode }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);

  if (failed) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={ref} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}
