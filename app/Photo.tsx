'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Фотография объекта с запасным видом.
 *
 * Ссылки на фото вставляют агенты руками, и они протухают: хостинг закрылся,
 * файл удалили, адрес опечатан. Без запасного вида каталог показывал бы
 * значок сломанной картинки — по нему посетитель судит не о ссылке, а об
 * агентстве.
 *
 * Одного onError мало, и это проверено: браузер грузит картинку из серверной
 * разметки ДО того, как React оживит страницу, и к моменту навешивания
 * обработчика событие уже прошло — значок сломанной картинки так и остался.
 * Поэтому после подключения мы ещё и спрашиваем саму картинку: загрузка
 * завершена (complete), а ширины нет (naturalWidth === 0) — значит, не вышло.
 */
export function Photo({ src }: { src: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);

  if (failed) return <span className="pub-nophoto key">фото недоступно</span>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={ref} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}
