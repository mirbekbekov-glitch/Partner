import { Photo } from './Photo';

/**
 * Лицо агента: снимок или две буквы имени.
 *
 * Отдельным файлом, потому что мест стало три — карточка на странице
 * объекта, список агентов и страница агента. Одинаковый кружок в трёх
 * местах, собранный трижды, однажды разъедется: в одном месте появится
 * запасной вид, в другом останется битая картинка.
 *
 * Пустой кружок читается как «фото не загрузилось», а две буквы — как
 * сознательный выбор, поэтому запасной вид именно такой.
 */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function AgentFace({
  name,
  avatarKey,
  big = false,
}: {
  name: string;
  avatarKey: string | null;
  big?: boolean;
}) {
  const initials = <span className="initials">{initialsOf(name)}</span>;

  return (
    <div className={big ? 'avatar avatar-big' : 'avatar'}>
      {avatarKey
        ? <Photo src={`/photos/${avatarKey}`} fallback={initials} />
        : initials}
    </div>
  );
}
