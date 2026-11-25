import { notFound, redirect } from 'next/navigation';
import { objectCard } from '@/lib/db/cabinet';
import { canEditObject } from '@/lib/db/access';
import { ObjectForm, type ObjectDraft } from '../../ObjectForm';
import { updateObject } from '../../form-actions';

export const metadata = { title: 'Правка объекта' };

export default async function EditObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const object = await objectCard(id);
  if (!object) notFound();

  // Право на правку считает предикат, а не код страницы: только он знает
  // про listing-агента активного мандата и про админа.
  if (!(await canEditObject(id))) redirect(`/cabinet/objects/${id}`);

  return (
    <>
      <h1>Правка объекта</h1>
      <p className="sub">{object.address}</p>
      <div className="card">
        <ObjectForm action={updateObject} draft={object as unknown as ObjectDraft} mode="edit" />
      </div>
    </>
  );
}
