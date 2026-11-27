/**
 * Подписи видов недвижимости для кабинета.
 *
 * Отдельно от публичного словаря lib/i18n.ts намеренно: тот знает четыре
 * языка и обслуживает посетителя, а кабинет русский. Тащить в кабинет
 * выбор языка только ради одной строки — лишняя связь между частями,
 * которые живут по разным правилам.
 */
export const KIND_LABEL: Record<string, string> = {
  flat: 'квартира',
  room: 'комната',
  house: 'дом',
  townhouse: 'таунхаус',
  land: 'участок',
  commercial: 'коммерческая',
  garage: 'гараж',
};

/**
 * Подробный вид помещения — то, что человек выбрал на самом деле.
 *
 * KIND_LABEL выше показывает огрублённое значение, и «коммерческая» в
 * ленте не отвечает на вопрос, звонить ли агенту по офисам или по
 * складам. Здесь — точное.
 */
export const SPACE_LABEL: Record<string, string> = {
  flat: 'квартира',
  room: 'комната, подселение',
  house: 'дом',
  townhouse: 'таунхаус',
  land: 'участок',
  garage: 'гараж, паркинг',
  office: 'офис',
  cabinet: 'кабинет',
  building: 'здание целиком',
  retail: 'торговое помещение',
  warehouse: 'склад',
  production: 'производство',
  desk: 'рабочее место в коворкинге',
};

/**
 * Срок аренды словами: «от 90 до 180 дней», «от года», «до месяца».
 *
 * Дни переводятся в привычные единицы только для глаз — в базе остаются
 * дни. Иначе пришлось бы хранить и единицу, и число, и держать их в
 * согласии.
 */
export function termLabel(min: number | null, max: number | null): string | null {
  if (!min && !max) return null;

  const word = (days: number): string => {
    if (days % 365 === 0) {
      const years = days / 365;
      return `${years} ${years === 1 ? 'год' : years < 5 ? 'года' : 'лет'}`;
    }
    if (days % 30 === 0) {
      const months = days / 30;
      return `${months} мес.`;
    }
    return `${days} дн.`;
  };

  if (min && max) return `${word(min)} — ${word(max)}`;
  if (min) return `от ${word(min)}`;
  return `до ${word(max!)}`;
}
