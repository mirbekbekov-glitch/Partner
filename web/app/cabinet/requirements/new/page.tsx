import type { Metadata } from "next";
import { inquiries, myContacts } from "../../../../lib/cabinet";
import { formatPhone } from "../../../../lib/format";
import { gate } from "../../Gate";
import { createRequirement } from "../../actions";
import { RequirementForm } from "./RequirementForm";

export const metadata: Metadata = {
  title: "Новый клиент",
  robots: { index: false, follow: false },
};

export default async function NewRequirementPage({
  searchParams,
}: {
  searchParams: Promise<{ inquiry?: string }>;
}) {
  const access = await gate();
  if (!access.ok) return access.screen;

  const { inquiry: inquiryId } = await searchParams;
  const contacts = await myContacts();

  // Обращение подставляется в форму, а не переносится молча: в обращении
  // имя и текст, а условия поиска агент выясняет разговором.
  const found = inquiryId
    ? (await inquiries()).find((i) => i.id === inquiryId)
    : undefined;

  return (
    <div className="wrap narrow">
      <p className="back"><a href="/cabinet/requirements">← к клиентам</a></p>
      <h1>Новый клиент</h1>

      {found ? (
        <p className="lead">
          Из обращения: {found.contact_name ?? "без имени"}. Заполните, что
          выяснили разговором, — обращение закроется этим же действием, и
          второй раз про него вспоминать не придётся.
        </p>
      ) : (
        <p className="lead">
          Клиент и то, что он ищет, заводятся одним действием. Подбор по этой
          потребности будет вести тот, кто её завёл.
        </p>
      )}

      <RequirementForm
        action={createRequirement}
        contacts={contacts.map((c) => ({
          id: c.id,
          name: c.name,
          phone: formatPhone(c.phone),
        }))}
        inquiry={
          found
            ? {
                id: found.id,
                name: found.contact_name,
                phone: found.contact_phone,
                body: found.body,
              }
            : undefined
        }
      />
    </div>
  );
}
