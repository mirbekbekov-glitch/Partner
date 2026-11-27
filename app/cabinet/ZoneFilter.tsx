'use client';

import { useState } from 'react';
import { Suggest } from '../Suggest';
import { GEO } from '@/lib/geo';

/**
 * Фильтр по району в списках кабинета.
 *
 * Те же подсказки, что и в карточке объекта: агент ищет по тому же
 * названию, каким заводил. Без города подсказываются районы всех
 * городов словаря — в фильтре город отдельным полем не спрашивают, и
 * сузить список не по чему.
 */

const ALL = [...new Set(GEO.flatMap((r) => r.cities.flatMap((c) => c.zones ?? [])))];

export function ZoneFilter({ value }: { value: string | null }) {
  const [zone, setZone] = useState(value ?? '');
  return <Suggest id="zone" name="zone" value={zone} onChange={setZone} options={ALL} />;
}
