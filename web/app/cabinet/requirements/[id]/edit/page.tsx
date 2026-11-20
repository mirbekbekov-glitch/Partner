import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirementDetail } from "../../../../../lib/cabinet";
import { formatPhone } from "../../../../../lib/format";
import { gate } from "../../../Gate";
import { updateContact, updateRequirement } from "../../../actions";
import { RequirementEditForm } from "./RequirementEditForm";

export const metadata: Metadata = {
  title: "Правка клиента",
  robots: { index: false, follow: false },
};

export default async function EditRequirementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { id } = await params;
  const data = await requirementDetail(id);
  if (!data) notFound();

  const r = data.requirement;

  if (!r.is_mine) {
    return (
      <div className="wrap narrow">
        <p className="back"><a href={`/cabinet/requirements/${id}`}>← к клиенту</a></p>
        <h1>Править нельзя</h1>
        <p className="lead">
          Этого клиента ведёт {r.agent_name ?? "другой агент"}. Условия
          поиска правит тот, кто с клиентом разговаривает.
        </p>
      </div>
    );
  }

  return (
    <div className="wrap narrow">
      <p className="back"><a href={`/cabinet/requirements/${id}`}>← к клиенту</a></p>
      <h1>Правка</h1>
      <p className="lead">{r.client_name ?? "Без имени"}</p>

      <RequirementEditForm
        updateRequirement={updateRequirement}
        updateContact={updateContact}
        requirement={{
          id: r.id,
          budget_min: r.budget_min ? String(Number(r.budget_min)) : "",
          budget_max: r.budget_max ? String(Number(r.budget_max)) : "",
          zones: r.zones.join(", "),
          rooms: r.rooms.join(", "),
          deadline: r.deadline ? new Date(r.deadline).toISOString().slice(0, 10) : "",
          requirements_text: r.requirements_text ?? "",
        }}
        client={
          data.contactId
            ? {
                id: data.contactId,
                name: r.client_name ?? "",
                phone: formatPhone(r.client_phone),
              }
            : null
        }
      />
    </div>
  );
}
