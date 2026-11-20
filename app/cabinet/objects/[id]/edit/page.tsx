import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ObjectForm, type ObjectDraft } from '../../ObjectForm';
import { updateObject } from '../../form-actions';

export const metadata = { title: 'Правка объекта' };

export default async function EditObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: object } = await supabase
    .from('objects')
    .select('id, kind, deal_type, address, zone, rooms, area, floor, floors_total, price, currency, description, photos')
    .eq('id', id)
    .maybeSingle();

  if (!object) notFound();

  // Право на правку спрашиваем у базы, а не выводим в коде: она одна знает
  // про listing-агента активного мандата и про админа.
  const { data: canEdit } = await supabase.rpc('can_edit_object', { p_object_id: id });
  if (canEdit === false) redirect(`/cabinet/objects/${id}`);

  return (
    <>
      <h1>Правка объекта</h1>
      <p className="sub">{object.address}</p>
      <div className="card">
        <ObjectForm action={updateObject} draft={object as ObjectDraft} mode="edit" />
      </div>
    </>
  );
}
