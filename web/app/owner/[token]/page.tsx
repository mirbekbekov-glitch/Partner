import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CHANNEL_LABEL, fetchOwnerCabinet } from "@/lib/report";
import {
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatPrice,
  formatRooms,
  freshness,
  plural,
} from "@/lib/format";
import { PauseForm } from "./PauseForm";

type Props = { params: Promise<{ token: string }> };

// Страница по секретной ссылке. В индекс ей нельзя ни при каких условиях.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "Мои объекты",
};

const BISHKEK = "Asia/Bishkek";

function when(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    timeZone: BISHKEK,
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function OwnerCabinetPage({ params }: Props) {
  const { token } = await params;
  const cabinet = await fetchOwnerCabinet(token);
  if (!cabinet) notFound();

  const { owner, objects } = cabinet;
  const ahead = objects.reduce((n, o) => n + o.showings_ahead.length, 0);

  return (
    <main className="wrap report">
      <p className="report-kicker">Ваши объекты в работе</p>
      <h1>{owner.name}</h1>
      <p className="lead">
        Здесь всё, что вы сдали или продаёте через агентство. Показы, площадки
        и свежесть объявления — и кнопка, которой вы закрываете дверь, когда
        это нужно вам, а не когда до агента дозвонитесь.
      </p>

      {ahead > 0 && (
        <p className="ok-banner">
          Впереди {ahead} {plural(ahead, "показ", "показа", "показов")}. Время
          каждого — в карточке объекта ниже.
        </p>
      )}

      {objects.length === 0 && (
        <p className="muted">
          Объектов с действующим договором за вами не числится. Если это
          ошибка, скажите агенту — ссылка остаётся рабочей.
        </p>
      )}

      {objects.map((o) => {
        const fresh = freshness(o.actual_at);
        const live = o.channels.filter((c) => c.in_feed);

        return (
          <section key={o.id} className={o.paused ? "report-block paused" : "report-block"}>
            <h2>{o.address}</h2>
            <p className="muted">
              {KIND_LABEL[o.kind] ?? o.kind} · {DEAL_LABEL[o.deal_type] ?? o.deal_type}
              {o.rooms ? ` · ${formatRooms(o.rooms)}` : ""}
              {o.area ? ` · ${formatArea(o.area)}` : ""}
            </p>

            <dl className="facts">
              <dt>Цена в объявлении</dt>
              <dd>{formatPrice(o.price, o.currency, o.deal_type)}</dd>

              <dt>Состояние</dt>
              <dd>
                {o.publication_state === "published" ? "в каталоге" : "не в каталоге"}
                {fresh ? ` · ${fresh.label}` : ""}
              </dd>

              <dt>Состоявшихся показов</dt>
              <dd>{o.showings_done}</dd>

              <dt>Куда отдаётся</dt>
              <dd>
                {live.length === 0
                  ? "пока никуда"
                  : live.map((c) => CHANNEL_LABEL[c.channel] ?? c.channel).join(", ")}
              </dd>
            </dl>

            {/* Ради этого кабинет и нужен: собственник, который живёт в
                квартире, должен знать, когда к нему придут. Ни имени, ни
                телефона клиента здесь нет и не будет. */}
            <h3>Когда придут</h3>
            {o.paused ? (
              <p className="warn-banner">
                Показы приостановлены{o.paused_by === "owner" ? " вами" : " агентством"}
                {o.pause_reason ? `: ${o.pause_reason}` : ""}. Новые не назначат,
                пока приостановка стоит.
              </p>
            ) : o.showings_ahead.length === 0 ? (
              <p className="muted">Показов пока не назначено.</p>
            ) : (
              <ul className="ahead">
                {o.showings_ahead.map((at) => (
                  <li key={at}>{when(at)}</li>
                ))}
              </ul>
            )}

            <PauseForm token={token} objectId={o.id} paused={o.paused} />
          </section>
        );
      })}

      <p className="report-note">
        Эта страница открыта по личной ссылке и в поиске не показывается. Имена
        и телефоны тех, кто смотрит вашу квартиру, в неё не попадают — мы не
        передаём их никому, включая вас, пока не началась сделка. Если что-то
        выглядит неверно, скажите агенту, который ведёт объект.
      </p>
    </main>
  );
}
