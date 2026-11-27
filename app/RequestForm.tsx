'use client';

import { useActionState } from 'react';
import { submitRequest, type RequestError } from './request-actions';
import { t, type Lang } from '@/lib/i18n';
import { publicMoney } from '@/lib/catalog-params';

/**
 * Форма «что вы ищете».
 *
 * Обязателен только телефон. Остальное — подсказки агенту: чем меньше
 * обязательных полей, тем больше заявок доходит, а недостающее агент
 * спросит в первом же разговоре.
 *
 * Согласие на показ телефона — отдельная галочка, а не мелкий текст под
 * кнопкой. Без неё агент увидит только параметры поиска: решение
 * принимает человек, и он должен видеть, что именно решает.
 */
export function RequestForm({ lang, districts }: { lang: Lang; districts: string[] }) {
  const d = t(lang);
  // useActionState, а не обработчик onSubmit: так форма уходит на сервер
  // POST-ом и без JavaScript. С ним — без перезагрузки страницы.
  const [result, action, pending] = useActionState(submitRequest, null);

  if (result?.ok) {
    return (
      <div className="sent-plate">
        <strong>{d.reqSent}</strong>
        <p>{d.reqSentNote}</p>
      </div>
    );
  }

  const error = result && !result.ok ? result.code : null;

  return (
    <form className="reqform" action={action}>
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="rq-website">{d.honeypotLabel}</label>
        <input id="rq-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset className="seg">
        <legend>{d.reqDeal}</legend>
        <label><input type="radio" name="deal" value="buy" defaultChecked />{d.reqBuy}</label>
        <label><input type="radio" name="deal" value="rent" />{d.reqRent}</label>
      </fieldset>

      <div className="reqgrid">
        <div className="cell">
          <label htmlFor="rq-type">{d.reqType}</label>
          <select id="rq-type" name="housing_type" defaultValue="">
            <option value="">{d.anyKind}</option>
            {Object.entries(d.kinds).map(([k, name]) => (
              <option key={k} value={k}>{name.charAt(0).toUpperCase() + name.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="cell">
          <label htmlFor="rq-rooms">{d.reqRooms}</label>
          <select id="rq-rooms" name="rooms" defaultValue="">
            <option value="">{d.anyRooms}</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="cell">
          <label htmlFor="rq-district">{d.reqDistrict}</label>
          {/* Список, а не свободный текст: на прежнем сайте свободное поле
              дало 271 написание на 280 заявок. Свой вариант всё равно
              можно вписать — база положит его отдельно, не портя список. */}
          <input id="rq-district" name="district" list="districts" autoComplete="off"
                 placeholder={d.reqDistrictAny} />
          <datalist id="districts">
            {districts.map((z) => <option key={z} value={z} />)}
          </datalist>
        </div>
        <div className="cell">
          <label htmlFor="rq-budget">{d.reqBudget}</label>
          <div className="pair">
            <input id="rq-budget" name="budget" type="number" min={0} step={1000}
                   inputMode="numeric" placeholder={d.priceHint} />
            <select name="budget_currency" defaultValue="USD" aria-label={d.reqBudget}>
              <option value="USD">$</option>
              <option value="KGS">сом</option>
            </select>
          </div>
        </div>
      </div>

      <div className="cell">
        <label htmlFor="rq-wishes">{d.reqWishes}</label>
        <textarea id="rq-wishes" name="wishes" rows={3} maxLength={2000}
                  placeholder={d.reqWishesHint} />
      </div>

      <div className="reqgrid">
        <div className="cell">
          <label htmlFor="rq-name">{d.yourName}</label>
          <input id="rq-name" name="name" type="text" maxLength={120}
                 autoComplete="name" placeholder={d.namePlaceholder} />
        </div>
        <div className="cell">
          <label htmlFor="rq-phone">{d.phone} *</label>
          <input id="rq-phone" name="phone" type="tel" required
                 autoComplete="tel" placeholder={d.phonePlaceholder} />
        </div>
      </div>

      <label className="consent">
        <input type="checkbox" name="consent" defaultChecked />
        <span>
          {d.reqConsent}
          <small>{d.reqConsentHint}</small>
        </span>
      </label>

      <button className="go" type="submit" disabled={pending}>
        {pending ? d.reqSending : d.reqSend}
      </button>

      {/* Бюджет ниже рынка — не «проверьте поля», а разговор по существу:
          сколько стоит искомое, на скольки объявлениях это видно, и
          кнопка, которая подставит порог. Человек не должен считать сам и
          не должен гадать, насколько он промахнулся. */}
      {error === 'LOW_BUDGET' && result?.floor ? (
        <div className="low-budget">
          <p>{d.reqLowBudget(
            publicMoney(lang, result.floor.amount, result.floor.currency),
            result.floor.basedOn,
          )}</p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const field = document.getElementById('rq-budget') as HTMLInputElement | null;
              if (field && result.floor) {
                field.value = String(result.floor.amount);
                field.focus();
              }
            }}
          >
            {d.reqUseFloor}
          </button>
        </div>
      ) : error ? (
        <p className="error">{errorText(d, error)}</p>
      ) : null}
    </form>
  );
}

function errorText(d: ReturnType<typeof t>, code: RequestError): string {
  if (code === 'BAD_PHONE') return d.reqErrPhone;
  if (code === 'BAD_INPUT') return d.reqErrInput;
  if (code === 'TOO_MANY') return d.reqErrMany;
  return d.reqErrGeneric;
}
