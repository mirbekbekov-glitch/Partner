'use client';

import { useActionState, useState } from 'react';
import { submitRequest, type RequestError } from './request-actions';
import { t, type Lang } from '@/lib/i18n';
import { publicMoney } from '@/lib/catalog-params';

/** Сторона заявки: человек ищет жильё или отдаёт своё. */
export type RequestSide = 'find' | 'own';

/**
 * Форма заявки — одна на обе стороны рынка.
 *
 * Обязателен только телефон. Остальное — подсказки агенту: чем меньше
 * обязательных полей, тем больше заявок доходит, а недостающее агент
 * спросит в первом же разговоре.
 *
 * Сторон две, потому что их две и в жизни: человек либо ищет жильё, либо
 * отдаёт своё. До сих пор на сайте была только первая, и собственнику
 * нажать было нечего — он звонил или уходил. Отдельной страницей их
 * разводить незачем: поля почти те же, меняются три подписи и адрес,
 * а две страницы пришлось бы держать в согласии руками.
 *
 * Переключатель — radio, а не две ссылки: выбор виден целиком, и человек,
 * нажавший не туда, возвращается не кнопкой «назад», а тем же движением.
 * Без JavaScript остаётся та сторона, с которой страница открылась.
 *
 * Согласие на показ телефона — отдельная галочка, а не мелкий текст под
 * кнопкой. Без неё агент увидит только параметры: решение принимает
 * человек, и он должен видеть, что именно решает.
 */
export function RequestForm({ lang, districts, side: initial = 'find' }: {
  lang: Lang;
  districts: string[];
  /** С какой стороны страница открылась: ссылка в шапке ведёт на «own». */
  side?: RequestSide;
}) {
  const d = t(lang);
  const [side, setSide] = useState<RequestSide>(initial);
  const own = side === 'own';
  // useActionState, а не обработчик onSubmit: так форма уходит на сервер
  // POST-ом и без JavaScript. С ним — без перезагрузки страницы.
  const [result, action, pending] = useActionState(submitRequest, null);

  if (result?.ok) {
    return (
      <div className="sent-plate">
        <strong>{d.reqSent}</strong>
        <p>{own ? d.reqOwnSentNote : d.reqSentNote}</p>
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

      {/* Сторона. Поле не уходит на сервер: сторону там определяет
          offer_deal — одно поле вместо двух, которые пришлось бы держать
          в согласии. */}
      <fieldset className="seg seg-side">
        <legend>{d.reqSideLegend}</legend>
        <label>
          <input type="radio" name="side" value="find" checked={!own}
                 onChange={() => setSide('find')} />
          {d.reqSideFind}
        </label>
        <label>
          <input type="radio" name="side" value="own" checked={own}
                 onChange={() => setSide('own')} />
          {d.reqSideOwn}
        </label>
      </fieldset>

      {/* Направление сделки. У ищущего это «купить или снять», у
          собственника — «продать или сдать», и уходят они в разные поля:
          заявка на поиск и заявка с объектом — разная работа агента. */}
      {own ? (
        <fieldset className="seg" key="own">
          <legend>{d.reqOwnDeal}</legend>
          <label><input type="radio" name="offer_deal" value="sale" defaultChecked />{d.reqSell}</label>
          <label><input type="radio" name="offer_deal" value="rent" />{d.reqLet}</label>
        </fieldset>
      ) : (
        <fieldset className="seg" key="find">
          <legend>{d.reqDeal}</legend>
          <label><input type="radio" name="deal" value="buy" defaultChecked />{d.reqBuy}</label>
          <label><input type="radio" name="deal" value="rent" />{d.reqRent}</label>
        </fieldset>
      )}

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
          {/* Бюджет у ищущего — потолок, у собственника — цена, которую он
              хочет. Поле одно: это сумма, вокруг которой пойдёт разговор. */}
          <label htmlFor="rq-budget">{own ? d.reqPrice : d.reqBudget}</label>
          <div className="pair">
            <input id="rq-budget" name="budget" type="number" min={0} step={1000}
                   inputMode="numeric" placeholder={d.priceHint} />
            <select name="budget_currency" defaultValue="USD"
                    aria-label={own ? d.reqPrice : d.reqBudget}>
              <option value="USD">$</option>
              <option value="KGS">сом</option>
            </select>
          </div>
        </div>
      </div>

      {/* Адрес есть только у того, кто объект отдаёт: ищут район, а не
          дом. Поле необязательное — агент уточнит по телефону, а требовать
          адрес до первого разговора значит терять половину звонков. */}
      {own ? (
        <div className="cell">
          <label htmlFor="rq-address">{d.reqAddress}</label>
          <input id="rq-address" name="address" type="text" maxLength={200}
                 autoComplete="off" placeholder={d.reqAddressHint} />
        </div>
      ) : null}

      <div className="cell">
        <label htmlFor="rq-wishes">{own ? d.reqOwnWishes : d.reqWishes}</label>
        <textarea id="rq-wishes" name="wishes" rows={3} maxLength={2000}
                  placeholder={own ? d.reqOwnWishesHint : d.reqWishesHint} />
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
