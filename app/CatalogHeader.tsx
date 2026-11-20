import Link from 'next/link';
import Image from 'next/image';
import { AGENCY_NAME, AGENCY_PHONES } from '@/lib/agency';
import logo from '../public/liberterra.png';

/**
 * Шапка публичной части.
 *
 * В знаке уже написано «Liberterra», поэтому подписи рядом нет: имя, набранное
 * дважды, читается как ошибка вёрстки. Название остаётся в alt — для тех, кто
 * слушает страницу, и для случая, когда картинка не загрузилась.
 *
 * width и height заданы по настоящему размеру файла: без них браузер не знает
 * пропорций до загрузки и дёргает вёрстку, когда картинка приходит.
 *
 * priority: знак стоит в самом верху первого экрана, и грузить его лениво
 * значит показать человеку пустое место там, куда он смотрит первым делом.
 *
 * Телефоны рядом с ним: в каталоге недвижимости звонок — то, ради чего человек
 * пришёл. Все три сразу: это разные операторы, и человек выбирает тот, что
 * дешевле ему. Вход для агентов — ссылкой в конце, служебная дверь.
 */
export function CatalogHeader() {
  return (
    <header className="pub-top">
      <Link href="/" className="pub-brand" aria-label={`${AGENCY_NAME} — на главную`}>
        <Image src={logo} alt={AGENCY_NAME} className="pub-logo" priority />
      </Link>

      <div className="pub-phones">
        {AGENCY_PHONES.map((p) => (
          <a key={p.href} href={p.href} className="pub-phone">{p.display}</a>
        ))}
      </div>

      <Link href="/login" className="key pub-agents">вход для агентов</Link>
    </header>
  );
}
