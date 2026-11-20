import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { objectDetail } from "../../../../../lib/cabinet";
import { formatPhone } from "../../../../../lib/format";
import { gate } from "../../../Gate";
import {
  updateClosingShare, updateContact, updateMandate, updateObject,
} from "../../../actions";
import { ObjectEditForm } from "./ObjectEditForm";

export const metadata: Metadata = {
  title: "Правка объекта",
  robots: { index: false, follow: false },
};

/** Число из базы в поле ввода: без хвоста «.00», который там не нужен. */
function plain(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export default async function EditObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { id } = await params;
  const data = await objectDetail(id);
  if (!data) notFound();

  const o = data.object;

  // Условие то же, что в триггере инварианта 22: ведёт объект listing-агент
  // действующего договора, а объект без договора — тот, кто его завёл. Экран
  // не решает, он показывает.
  if (!data.canEditObject) {
    return (
      <div className="wrap narrow">
        <p className="back"><a href={`/cabinet/objects/${id}`}>← к объекту</a></p>
        <h1>Править нельзя</h1>
        <p className="lead">
          Объект ведёт агент действующего договора с собственником. По этому
          объекту договор у другого агента — попросите его или администратора.
        </p>
      </div>
    );
  }

  const owner = data.owners[0] ?? null;

  return (
    <div className="wrap narrow">
      <p className="back"><a href={`/cabinet/objects/${id}`}>← к объекту</a></p>
      <h1>Правка</h1>
      <p className="lead">{o.address}</p>

      <ObjectEditForm
        updateObject={updateObject}
        updateMandate={updateMandate}
        updateClosingShare={updateClosingShare}
        updateContact={updateContact}
        object={{
          id: o.id,
          kind: o.kind,
          address: o.address,
          price: plain(o.price),
          currency: o.currency,
          zone: o.zone ?? "",
          rooms: plain(o.rooms),
          area: plain(o.area),
          floor: plain(o.floor),
          floors_total: plain(o.floors_total),
          description: o.description ?? "",
        }}
        mandate={
          data.mandate
            ? {
                id: data.mandate.id,
                kind: data.mandate.kind,
                valid_to: data.mandate.valid_to
                  ? new Date(data.mandate.valid_to).toISOString().slice(0, 10)
                  : "",
                contract_confirmed: data.mandate.contract_confirmed,
                closing_percent: data.mandate.closing_share_ratio
                  ? String(Math.round(Number(data.mandate.closing_share_ratio) * 100))
                  : "50",
              }
            : null
        }
        owner={
          owner
            ? { id: owner.contact_id, name: owner.name, phone: formatPhone(owner.phones[0] ?? null) }
            : null
        }
      />
    </div>
  );
}
