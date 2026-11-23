import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintBar } from "../PrintBar";
import { asReportRole } from "../../../lib/db";
import { formatDate,
  DEAL_LABEL,
  KIND_LABEL,
  formatArea,
  formatPrice,
  formatRooms,
  plural,
} from "../../../lib/format";
import type { DealType, ObjectKind } from "../../../lib/types";

type Item = {
  id: string;
  address: string;
  kind: ObjectKind;
  deal_type: DealType;
  price: string;
  currency: string;
  rooms: number | null;
  area: string | null;
  floor: number | null;
  floors_total: number | null;
  zone: string | null;
  description: string | null;
  reaction: string | null;
  photos: string[];
};

type Page = {
  note: string | null;
  sent_at: string;
  /** Агентство отправителя — брендирование листа (миграция 0053). */
  agency_name: string | null;
  objects: Item[];
};

// Страница по секретной ссылке. В индекс ей нельзя ни при каких условиях.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "Подборка",
};

async function fetchSelection(token: string): Promise<Page | null> {
  return asReportRole(async (db) => {
    const { rows } = await db.query<{ body: Page | null }>(
      "select app.selection_page($1) as body",
      [token],
    );
    return rows[0]?.body ?? null;
  });
}

export default async function SelectionPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const page = await fetchSelection(token);
  if (!page) notFound();

  const n = page.objects.length;

  return (
    <main className="wrap report">
      <p className="report-kicker">Подборка для вас</p>
      <h1>
        {n} {plural(n, "вариант", "варианта", "вариантов")}
      </h1>

      {/* От кого и когда. Нужно и на экране, и на листе, но по разным
          причинам. На экране клиент видит в шапке «Liberterra» — платформу, —
          а прислало ему агентство, и это разные вещи. На листе шапки сайта
          нет вовсе, и без этой строки документ, который клиент показывает
          мужу, матери или банку, выглядит ничьим.

          Дата здесь не украшение: подборка недвижимости без даты через месяц
          говорит неправду с тем же уверенным видом — цены стареют. */}
      <p className="sent-by">
        {page.agency_name ? `${page.agency_name} · ` : ""}
        {formatDate(page.sent_at)}
      </p>

      {page.note && <p className="lead">{page.note}</p>}

      {n > 0 && <PrintBar />}

      {n === 0 && (
        <p className="muted">
          Варианты из этой подборки уже сняты с продажи. Напишите агенту — он
          соберёт новую.
        </p>
      )}

      {page.objects.map((o) => (
        <section key={o.id} className="report-block">
          <h2>{o.address}</h2>
          <p className="muted">
            {KIND_LABEL[o.kind] ?? o.kind} · {DEAL_LABEL[o.deal_type] ?? o.deal_type}
            {o.rooms ? ` · ${formatRooms(o.rooms)}` : ""}
            {o.area ? ` · ${formatArea(o.area)}` : ""}
            {o.floor ? ` · ${o.floor}${o.floors_total ? ` из ${o.floors_total}` : ""} этаж` : ""}
            {o.zone ? ` · ${o.zone}` : ""}
          </p>

          <p className="price-line">{formatPrice(o.price, o.currency, o.deal_type)}</p>

          {o.photos.length > 0 && (
            <div className="shots">
              {o.photos.slice(0, 6).map((key) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img key={key} src={`/photo/${key}`} alt={o.address} loading="lazy" />
              ))}
            </div>
          )}

          {o.description && <p>{o.description}</p>}

          {o.reaction && (
            <p className="faint sm">
              вы отметили: {o.reaction === "liked" ? "нравится"
                : o.reaction === "disliked" ? "не подошло" : "думаю"}
            </p>
          )}
        </section>
      ))}

      <p className="report-note">
        Эта страница открыта по личной ссылке и в поиске не показывается. Что
        понравилось, а что нет — скажите агенту: это и есть то, по чему он
        соберёт следующую подборку. Если вариант уже продан, он отсюда
        пропадёт сам.
      </p>
    </main>
  );
}
