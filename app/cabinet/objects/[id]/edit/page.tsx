import { notFound, redirect } from 'next/navigation';
import { objectCard } from '@/lib/db/cabinet';
import { canEditObject } from '@/lib/db/access';
import { ObjectForm } from '../../ObjectForm';
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
        {/* Без приведения типа. Раньше здесь стояло `as unknown as
            ObjectDraft`, и оно скрывало настоящее расхождение: objectCard
            отдавал снимки строкой с JSON, а форма ждала массив. Проверка
            типов молчала, страница падала в браузере. Теперь objectCard
            отдаёт массив, и приведение больше не нужно — а если тип снова
            разойдётся, сборка скажет об этом вместо посетителя. */}
        <ObjectForm action={updateObject} draft={object} mode="edit" />
      </div>
    </>
  );
}
