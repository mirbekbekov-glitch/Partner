'use server';

import { revalidatePath } from 'next/cache';
import { transferContact as moveContact } from '@/lib/db/contacts';
import { transferObject as moveObject } from '@/lib/db/objects';
import { explain } from '@/lib/db/report';

export type TransferResult = { error: string | null; done: string | null };

/**
 * Передача клиента и объекта.
 *
 * Что именно переезжает и когда передача невозможна, решает слой доступа:
 * перенос затрагивает несколько таблиц и обязан быть одной транзакцией, а
 * отказ при открытых сделках — правило, а не подсказка формы.
 */
export async function transferContact(formData: FormData): Promise<TransferResult> {
  try {
    const r = await moveContact(
      String(formData.get('contact_id') ?? ''),
      String(formData.get('to_agent_id') ?? ''),
    );

    revalidatePath('/cabinet/contacts', 'layout');
    revalidatePath('/cabinet/requirements', 'layout');
    revalidatePath('/cabinet');

    return {
      error: null,
      done:
        `Клиент «${r.contact_name}» передан. Переехало потребностей: `
        + `${r.requirements}, подборов: ${r.matches}.`,
    };
  } catch (e) {
    return { error: explain(e), done: null };
  }
}

export async function transferObject(formData: FormData): Promise<TransferResult> {
  const id = String(formData.get('object_id') ?? '');

  try {
    const r = await moveObject(id, String(formData.get('to_agent_id') ?? ''));

    revalidatePath(`/cabinet/objects/${id}`);
    revalidatePath('/cabinet/objects');
    revalidatePath('/cabinet');

    return {
      error: null,
      done:
        `Объект «${r.address}» передан.`
        + (r.mandate_moved
          ? ' Мандат переехал вместе с ним, а с ним и доля listing-агента.'
          : ''),
    };
  } catch (e) {
    return { error: explain(e), done: null };
  }
}
