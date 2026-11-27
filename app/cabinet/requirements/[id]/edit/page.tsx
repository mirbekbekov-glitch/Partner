import { notFound } from 'next/navigation';
import { requirementCard } from '@/lib/db/cabinet';
import { RequirementForm } from '../../RequirementForm';
import { updateRequirement } from '../../form-actions';

export const metadata = { title: 'Правка потребности' };

export default async function EditRequirementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const requirement = await requirementCard(id);
  if (!requirement) notFound();

  return (
    <>
      <h1>Правка потребности</h1>
      <div className="card">
        <RequirementForm
          action={updateRequirement}
          draft={requirement}
          mode="edit"
        />
      </div>
    </>
  );
}
