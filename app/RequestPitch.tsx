import Link from 'next/link';
import { t, type Lang } from '@/lib/i18n';

/**
 * Полоса «оставьте заявку» на главной.
 *
 * Это не баннер, а объяснение механики, которой у конкурентов нет: человек
 * описывает, что ищет, и агенты несут ему варианты — в том числе те,
 * которых в открытом каталоге нет и не будет. Устройство то же, что у
 * вызова машины: заявка одна, предложений несколько.
 *
 * Поэтому здесь три шага, а не лозунг. Лозунгу не верят, а последовательность
 * «что я сделаю → что произойдёт → что получу» человек проверяет сам и
 * понимает за секунду, без чтения условий.
 *
 * Полоса тёмная и стоит сразу под выдачей: именно там человек понимает,
 * что подходящего в каталоге нет.
 */
export function RequestPitch({ lang }: { lang: Lang }) {
  const d = t(lang);
  return (
    <section className="pitch">
      <div className="pitch-in wrap">
        <div className="pitch-text">
          <span className="eyebrow">{d.pitchEyebrow}</span>
          <h2>{d.pitchTitle}</h2>
          <p>{d.pitchLede}</p>
          <Link href={`/${lang}/request`} className="pitch-go">
            {d.pitchButton}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 9h12M10 4l5 5-5 5" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>

        <ol className="steps">
          <li>
            <span className="step-n num">1</span>
            <b>{d.pitchStep1}</b>
            <small>{d.pitchStep1Note}</small>
          </li>
          <li>
            <span className="step-n num">2</span>
            <b>{d.pitchStep2}</b>
            <small>{d.pitchStep2Note}</small>
          </li>
          <li>
            <span className="step-n num">3</span>
            <b>{d.pitchStep3}</b>
            <small>{d.pitchStep3Note}</small>
          </li>
        </ol>
      </div>
    </section>
  );
}
