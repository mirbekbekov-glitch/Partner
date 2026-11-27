'use client';

import { useState } from 'react';
import { ZonePick, type ZoneOption } from './ZonePick';

/**
 * Где искать: регион → город → район.
 *
 * Три поля связаны: смена региона обнуляет город, смена города —
 * район. Иначе остался бы «Чуйская область, Ош, Асанбай» — набор,
 * которого не существует, и человек увидел бы пустую выдачу, не поняв,
 * почему.
 *
 * Район — отдельным списком с поиском, потому что районов города
 * четыре десятка. Регион и город — обычными списками: там по десятку
 * строк, и свой список был бы сложностью без выигрыша.
 *
 * Словарь приходит с сервера целиком: он маленький (десятки строк) и
 * неизменный, и ходить за ним на каждое нажатие значило бы сделать
 * выбор города медленнее, чем он есть.
 */

export type GeoData = {
  regions: string[];
  cities: Record<string, string[]>;
  zones: Record<string, string[]>;
  counts: Record<string, number>;
};

export function GeoPick({
  value, regions, citiesOf, zonesOf, counts,
  regionLabel, cityLabel, zoneLabel, anyLabel, searchHint, emptyHint,
}: {
  value: { region: string | null; city: string | null; zone: string | null };
  regions: string[];
  citiesOf: Record<string, string[]>;
  zonesOf: Record<string, string[]>;
  /** Сколько объектов в районе: число рядом со строкой списка. */
  counts: Record<string, number>;
  regionLabel: string;
  cityLabel: string;
  zoneLabel: string;
  anyLabel: string;
  searchHint: string;
  emptyHint: string;
}) {
  const [region, setRegion] = useState(value.region ?? '');
  const [city, setCity] = useState(value.city ?? '');
  const [zone, setZone] = useState(value.zone ?? '');

  const cities = region
    ? (citiesOf[region] ?? [])
    : [...new Set(Object.values(citiesOf).flat())];

  // Город в каталоге один — район спрашивают, не дожидаясь, пока его
  // выберут: выбирать не из чего, и лишний шаг был бы только помехой.
  // Но стоит человеку тронуть регион, умолчание отменяется: районы
  // Бишкека при выбранном Иссык-Куле — чужая география.
  const only = Object.keys(zonesOf);
  const forCity = city || (!region && only.length === 1 ? only[0] : '');
  const zoneNames = zonesOf[forCity] ?? [];
  const options: ZoneOption[] = zoneNames.map((z) => ({ zone: z, n: counts[z] ?? 0 }));

  return (
    <>
      <div className="cell">
        <label htmlFor="region">{regionLabel}</label>
        <select id="region" name="region" value={region}
                onChange={(e) => { setRegion(e.target.value); setCity(''); setZone(''); }}>
          <option value="">{anyLabel}</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="cell">
        <label htmlFor="city">{cityLabel}</label>
        <select id="city" name="city" value={city}
                onChange={(e) => { setCity(e.target.value); setZone(''); }}>
          <option value="">{anyLabel}</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* У города без списка районов поле не появляется: пустой список —
          это обещание выбора, которого нет. Район такого города
          остаётся в общем поле адреса. */}
      {options.length > 0 ? (
        <ZonePick label={zoneLabel} value={zone} options={options} onPick={setZone}
                  anyLabel={anyLabel} searchHint={searchHint} emptyHint={emptyHint} />
      ) : null}
    </>
  );
}
