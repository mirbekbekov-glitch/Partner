import type { Metadata } from "next";
import { summary } from "../../lib/cabinet";
import { plural } from "../../lib/format";
import { gate } from "./Gate";

export const metadata: Metadata = {
  title: "Кабинет агента",
  robots: { index: false, follow: false },
};

/**
 * Плитка сводки.
 *
 * Подпись склоняется по числу: «1 требуют внимания» и «4 новых обращений» —
 * это мелочь, которой не бывает в готовом продукте, и первая, по которой
 * видно, что продукт не готов.
 */
function Tile({
  value,
  one,
  few,
  many,
  href,
  alarm,
  hint,
}: {
  value: number;
  one: string;
  few: string;
  many: string;
  href: string;
  alarm?: boolean;
  hint?: string;
}) {
  return (
    <a className={alarm && value > 0 ? "tile alarm" : "tile"} href={href}>
      <strong>{value}</strong>
      <span>{plural(value, one, few, many)}</span>
      {hint && <em>{hint}</em>}
    </a>
  );
}

export default async function CabinetHome() {
  const access = await gate();
  if (!access.ok) return access.screen;

  const s = await summary();
  if (!s) return null;

  return (
    <div className="wrap">
      <h1>Здравствуйте, {access.agent.full_name.split(" ")[0]}</h1>

      <section className="tiles">
        <Tile value={s.objects_mine} one="мой объект" few="моих объекта"
              many="моих объектов" href="/cabinet/objects" />
        <Tile value={s.objects_published} one="в каталоге" few="в каталоге"
              many="в каталоге" href="/cabinet/objects" />
        <Tile
          value={s.stale_critical}
          one="объект требует внимания срочно"
          few="объекта требуют внимания срочно"
          many="объектов требуют внимания срочно"
          href="/cabinet/objects"
          alarm
          hint="просроченный договор или давно не подтверждали"
        />
        <Tile
          value={s.inquiries_new}
          one="новое обращение" few="новых обращения" many="новых обращений"
          href="/cabinet/inquiries"
          alarm
          hint="чем дольше ждёт, тем меньше шансов"
        />
        <Tile value={s.candidates_mine} one="объявление в работе"
              few="объявления в работе" many="объявлений в работе"
              href="/cabinet/candidates" />
        <Tile value={s.requirements_mine} one="клиент в работе" few="клиента в работе"
              many="клиентов в работе" href="/cabinet/requirements" />
        <Tile value={s.showings_upcoming} one="показ впереди" few="показа впереди"
              many="показов впереди" href="/cabinet/showings" />
        <Tile
          value={s.notifications_stuck}
          one="уведомление не ушло" few="уведомления не ушли" many="уведомлений не ушли"
          href="/cabinet/notifications"
          alarm
          hint="канал не принял их; они вернутся в очередь"
        />
        <Tile
          value={s.showings_overdue}
          one="показ без исхода" few="показа без исхода" many="показов без исхода"
          href="/cabinet/showings"
          alarm
          hint="время прошло, а что получилось — не записано"
        />
        <Tile value={s.deals_open} one="сделка в работе" few="сделки в работе"
              many="сделок в работе" href="/cabinet/deals" />
        <Tile
          value={s.deals_stuck}
          one="сделка стоит на этапе" few="сделки стоят на этапе"
          many="сделок стоят на этапе"
          href="/cabinet/deals"
          alarm
          hint="дольше, чем этому этапу отведено"
        />
        {access.agent.is_admin && (
          <Tile
            value={s.agents_pending}
            one="агент ждёт одобрения" few="агента ждут одобрения"
            many="агентов ждут одобрения"
            href="/cabinet/agents"
            alarm
          />
        )}
        {access.agent.is_admin && (
          <Tile
            value={s.scheduler_broken}
            one="работа расписания не в норме" few="работы расписания не в норме"
            many="работ расписания не в норме"
            href="/cabinet/scheduler"
            alarm
            hint="молчащий планировщик не даёт ошибок — он просто ничего не делает"
          />
        )}
      </section>

      <section className="card">
        <h2>Весь путь в кабинете</h2>
        <p>
          Обращение → клиент → объект → подбор → показ → сделка. Каждый шаг
          оставляет след, и ни один нельзя пропустить: сделки без подбора не
          бывает, подбора без договора тоже.
        </p>
      </section>
    </div>
  );
}
