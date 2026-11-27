import type { MetadataRoute } from 'next';
import { AGENCY_NAME } from '@/lib/agency';

/**
 * Описание приложения для экрана «Домой».
 *
 * Нужно Android и новым версиям iOS: по нему ярлык открывает сайт
 * отдельным окном, без адресной строки и кнопок браузера. Кабинет этим и
 * пользуются — агент заходит в него по десять раз на дню, и полоса
 * браузера занимает место, не давая ничего.
 *
 * start_url ведёт в КАБИНЕТ, а не на главную: ярлык ставят ради него.
 * Неавторизованного middleware отправит на вход — это та же дорога, по
 * которой он ходит из браузера.
 *
 * Цвета взяты из дизайн-системы: фон страницы и белый квадрат значка.
 * Тёмную тему здесь не описать — манифест один, а тема переключается в
 * самом приложении.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${AGENCY_NAME} — кабинет агента`,
    short_name: AGENCY_NAME,
    description: 'Объекты, клиенты и сделки агентства недвижимости.',
    start_url: '/cabinet',
    display: 'standalone',
    lang: 'ru',
    background_color: '#FFFFFF',
    theme_color: '#FAFAF7',
    icons: [
      { src: '/icon.png', sizes: '180x180', type: 'image/png' },
      // purpose: maskable — чтобы Android не обрезал знак при вписывании
      // в свою форму значка, а положил его на белый квадрат целиком.
      { src: '/apple-icon.png', sizes: '180x180', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
