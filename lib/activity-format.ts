/**
 * Дата и время записи — коротко.
 *
 * Отдельным модулем, а не в Activities.tsx, по той же причине, что и
 * KIND_RU: тот файл помечен 'use client', и серверная страница задач,
 * вызывая оттуда функцию, звала не её, а ссылку на клиентский модуль —
 * страница падала с 500, как только у агента появлялась запись с датой.
 */
export const activityWhen = (v: string | null) =>
  v == null ? '' : new Date(v).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
