'use client';

import { useActionState } from 'react';
import { objectAction, type FormResult } from './form-actions';

/**
 * Условия комиссии действующего договора.
 *
 * Отдельной формой на карточке, а не полями в правке объекта: комиссию
 * меняют чаще, чем переписывают адрес, и ради неё незачем открывать всю
 * карточку целиком. К тому же менять её вправе тот, кто заключил
 * договор, а правка объекта открыта шире.
 *
 * Показывается свёрнутой: это условие, которое называют один раз и
 * иногда уточняют, а не поле, на которое смотрят каждый день.
 */

export function CommissionForm({
  objectId, mandateId, dealType, commissionPercent, partnerRate,
}: {
  objectId: string;
  mandateId: string;
  dealType: 'rent' | 'sale';
  /** Нынешний процент комиссии. Пусто — работает базовое правило. */
  commissionPercent: number | null;
  partnerRate: number | null;
}) {
  const [state, action, pending] = useActionState<FormResult, FormData>(
    async (_prev, fd) => objectAction(fd),
    { error: null },
  );

  const rent = dealType === 'rent';
  const dec = (n: number | null) => (n === null ? '' : String(n).replace('.', ','));

  return (
    <details className="more terms">
      <summary>Изменить условия комиссии</summary>
      <form action={action} className="terms-form">
        <input type="hidden" name="id" value={objectId} />
        <input type="hidden" name="what" value="commission_terms" />
        <input type="hidden" name="mandate_id" value={mandateId} />
        <input type="hidden" name="deal_type" value={dealType} />

        <div className="field s1">
          <label className="key" htmlFor="commission_percent">
            Комиссия, %{rent ? ' от месяца' : ' от цены'}
          </label>
          <input id="commission_percent" name="commission_percent" type="text"
                 inputMode="decimal" defaultValue={dec(commissionPercent)}
                 placeholder={rent ? '50' : '2'} />
        </div>

        <div className="field s1">
          <label className="key" htmlFor="partner_rate">
            Партнёру, %{rent ? ' от месяца' : ' от цены'}
          </label>
          <input id="partner_rate" name="partner_rate" type="text"
                 inputMode="decimal" defaultValue={dec(partnerRate)}
                 placeholder={rent ? '20' : '1'} />
        </div>

        <button type="submit" disabled={pending}>
          {pending ? 'Сохраняем…' : 'Сохранить'}
        </button>

        <p className="key">
          {rent
            ? 'Партнёру обычно 10–30 % месячной платы.'
            : 'Партнёру обычно 0,5–2 % от цены.'}
          {' '}Пусто — базовое правило и половина комиссии. Ноль значит ноль.
        </p>
        {state.error ? <p className="warn">{state.error}</p> : null}
      </form>
    </details>
  );
}
