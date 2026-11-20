import type { Metadata } from "next";
import { candidateForObject, myContacts } from "../../../../lib/cabinet";
import { formatPhone } from "../../../../lib/format";
import { gate } from "../../Gate";
import { createObject } from "../../actions";
import { ObjectForm } from "./ObjectForm";

export const metadata: Metadata = {
  title: "Новый объект",
  robots: { index: false, follow: false },
};

/**
 * Заведение объекта.
 *
 * Форма одна, а не мастер из трёх шагов, потому что в жизни это один
 * разговор с собственником: вот квартира, вот хозяин, вот договор. Мастер
 * позволил бы остановиться на втором шаге — ровно то, из-за чего появлялись
 * объекты, с которыми ничего нельзя сделать.
 */
export default async function NewObjectPage({
  searchParams,
}: {
  searchParams: Promise<{ candidate?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { candidate: candidateId } = await searchParams;
  const candidate = candidateId ? await candidateForObject(candidateId) : null;
  const contacts = await myContacts();

  return (
    <div className="wrap narrow">
      <p className="back"><a href="/cabinet/objects">← к объектам</a></p>
      <h1>Новый объект</h1>

      {candidate ? (
        <p className="lead">
          Из объявления с {candidate.source === "house_kg" ? "house.kg" : candidate.source}.
          Поля заполнены по объявлению — проверьте их у собственника: в
          объявлениях ошибаются. Как только объект будет заведён, объявление
          закроется и из пула исчезнет.
        </p>
      ) : (
        <p className="lead">
          Объект заводится вместе с собственником и договором — одним
          действием. Без договора объект нельзя ни опубликовать, ни показать,
          ни отчитаться по нему, поэтому отдельно от него он и не заводится.
        </p>
      )}

      <ObjectForm
        action={createObject}
        candidateId={candidate?.id}
        contacts={contacts.map((c) => ({
          id: c.id,
          name: c.name,
          phone: formatPhone(c.phone),
        }))}
        initial={{
          kind: candidate?.kind ?? "flat",
          deal_type: candidate?.deal_type ?? "sale",
          address: candidate?.address ?? "",
          price: candidate?.price ?? "",
          currency: candidate?.currency ?? "USD",
          zone: candidate?.zone ?? "",
          rooms: candidate?.rooms != null ? String(candidate.rooms) : "",
          area: candidate?.area ?? "",
          floor: candidate?.floor != null ? String(candidate.floor) : "",
          floors_total:
            candidate?.floors_total != null ? String(candidate.floors_total) : "",
          description: candidate?.description ?? "",
          contact_id: "",
          owner_name: "",
          owner_phone: candidate?.phone ?? "",
          mandate_kind: "non_exclusive",
          valid_to: "",
        }}
      />
    </div>
  );
}
