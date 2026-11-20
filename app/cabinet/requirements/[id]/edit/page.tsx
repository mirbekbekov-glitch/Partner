import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RequirementForm, type RequirementDraft } from '../../RequirementForm';
import { updateRequirement } from '../../form-actions';

export const metadata = { title: 'Правка потребности' };

export default async function EditRequirementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: requirement } = await supabase
    .from('requirements')
    .select('id, deal_type, budget_min, budget_max, zones, rooms, deadline, requirements_text, status, closed_reason')
    .eq('id', id)
    .maybeSingle();

  if (!requirement) notFound();

  return (
    <>
      <h1>Правка потребности</h1>
      <div className="card">
        <RequirementForm
          action={updateRequirement}
          draft={requirement as RequirementDraft}
          mode="edit"
        />
      </div>
    </>
  );
}
