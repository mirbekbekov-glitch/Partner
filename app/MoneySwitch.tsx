'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Money } from '@/lib/fx';

/**
 * Переключатель валюты показа.
 *
 * Пишет выбор в АДРЕС, а не в cookie. Ссылкой на подборку делятся, и
 * получатель должен увидеть те же цены в той же валюте, что отправитель;
 * с cookie он увидел бы свои, и разговор «смотри, за сколько» развалился
 * бы на ровном месте.
 *
 * Ссылками, а не кнопками: это навигация, у неё должен работать средний
 * щелчок и «открыть в новой вкладке». Router.replace вместо push —
 * переключение валюты не событие, за которым хочется вернуться кнопкой
 * «назад»; иначе история забивается одним и тем же экраном.
 *
 * Показывается только когда курс известен: без курса пересчитывать нечем,
 * и переключатель обещал бы то, чего не сделает.
 */
export function MoneySwitch({ value, label }: { value: Money; label: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();

  const go = (money: Money) => {
    const next = new URLSearchParams(params.toString());
    next.set('cur', money);
    // Страница выдачи сбрасывается: в другой валюте отбор по цене даёт
    // другое число объектов, и третья страница может перестать
    // существовать.
    next.delete('page');
    router.replace(`${path}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="money-switch" role="group" aria-label={label}>
      {(['USD', 'KGS'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => go(m)}
          aria-pressed={value === m}
          className={value === m ? 'on' : undefined}
        >
          {m === 'USD' ? '$' : 'сом'}
        </button>
      ))}
    </div>
  );
}
