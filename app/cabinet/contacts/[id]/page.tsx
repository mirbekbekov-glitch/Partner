import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  activityFeed, contactCard, contactObjects, contactPhoneList, duplicatesOf,
  linkableObjects, requirementList,
} from '@/lib/db/cabinet';
import { approvedColleagues } from '@/lib/db/agents';
import { money } from '@/lib/list-params';
import { Activities, type ActivityRow } from '../../Activities';
import { TransferForm, type Colleague } from '../../TransferForm';
import { transferContact } from '../../transfer-actions';
import { ContactForm, ROLE_RU, type ContactDraft } from '../ContactForm';
import { Phones, type Phone } from '../Phones';
import { MergeForm, type DuplicateCandidate } from '../MergeForm';
import { Ownerships, type OwnershipRow, type LinkableObject } from '../Ownerships';
import { updateContact } from '../actions';

export const metadata = { title: 'Контакт' };

const REQ_STATUS_RU: Record<string, string> = {
  new: 'новая', qualified: 'квалифицирована', in_showings: 'в показах',
  in_deal: 'в сделке', closed: 'закрыта', lost: 'отвал',
};

export default async function ContactCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const contact = await contactCard(id);
  if (!contact) notFound();

  const [phones, objects, requirements, activities, colleagues, duplicates, linkable] =
    await Promise.all([
      contactPhoneList(id),
      contactObjects(id),
      requirementList().then((rows) => rows.filter((r) => r.client_name === contact.name)),
      activityFeed('contact', id),
      approvedColleagues(),
      // Кандидаты в дубликаты — только среди своих записей: объединять
      // можно лишь обе свои, иначе объединение становится способом забрать
      // чужого клиента.
      duplicatesOf(id),
      linkableObjects(),
    ]);



  const c = contact as unknown as {
    id: string; kind: string; name: string; telegram: string | null;
    source: string | null; roles: string[] | null; note: string | null;
    owner_name: string | null; mine: boolean;
  };

  // Править контакт может тот, кто его привёл, и админ. Признак mine сюда
  // приходит из представления; админ правит и чужие, поэтому форму
  // показываем, если правка вообще прошла бы — ошибку покажет база.
  const canEdit = c.mine;

  return (
    <>
      <h1>{c.name}</h1>
      <p className="sub">
        {c.kind === 'company' ? 'Компания' : 'Человек'}
        {(c.roles ?? []).length > 0
          ? ` · ${(c.roles ?? []).map((r) => ROLE_RU[r] ?? r).join(', ')}`
          : ' · роль не указана'}
        {!c.mine ? ` · привёл ${c.owner_name}` : ''}
      </p>

      {c.note ? <div className="card"><p style={{ margin: 0 }}>{c.note}</p></div> : null}

      <Phones
        contactId={c.id}
        phones={phones as unknown as Phone[]}
        canEdit={canEdit}
      />

      <Ownerships
        contactId={c.id}
        rows={(objects ?? []) as OwnershipRow[]}
        linkable={(linkable ?? []) as LinkableObject[]}
        canEdit={canEdit}
      />

      <h2>Потребности ({(requirements ?? []).length})</h2>
      {(requirements ?? []).length === 0 ? (
        <p className="empty">
          Потребностей нет.{' '}
          <Link href="/cabinet/requirements/new">завести потребность →</Link>
        </p>
      ) : (
        <>
          {(requirements ?? []).map((r) => (
            <div className="card" key={r.id}>
              <div className="row">
                <Link href={`/cabinet/requirements/${r.id}`}>
                  <strong>
                    {money(r.budget_min)} – {money(r.budget_max)}
                  </strong>
                </Link>
                <span className="tag">{REQ_STATUS_RU[r.status] ?? r.status}</span>
                <span className="key">{r.deal_type === 'sale' ? 'покупка' : 'аренда'}</span>
                <span className="key">подборов {r.matches_count}</span>
              </div>
            </div>
          ))}
          {/* У одного человека их может быть несколько одновременно —
              это прямо в модели, поэтому ссылка стоит и когда они уже есть. */}
          <p className="key">
            <Link href="/cabinet/requirements/new">добавить ещё потребность →</Link>
          </p>
        </>
      )}

      <Activities
        entityType="contact"
        entityId={c.id}
        rows={(activities ?? []) as ActivityRow[]}
      />

      {canEdit ? (
        <>
          <h2>Правка</h2>
          <div className="card">
            <ContactForm action={updateContact} draft={c as ContactDraft} mode="edit" />
          </div>

          <h2>Объединить дубликат</h2>
          <MergeForm
            keepId={c.id}
            keepName={c.name}
            candidates={duplicates as unknown as DuplicateCandidate[]}
          />

          <h2>Передача</h2>
          <TransferForm
            action={transferContact}
            idField="contact_id"
            idValue={c.id}
            colleagues={(colleagues ?? []) as Colleague[]}
            what="клиента"
            warning="Клиент перейдёт коллеге целиком: контакт, все его открытые потребности и подборы по ним — вместе с долей closing-агента в комиссии. Телефон вы больше видеть не будете."
          />
        </>
      ) : (
        <p className="key">
          Правка и передача доступны тому, кто привёл контакт, и администратору.
        </p>
      )}
    </>
  );
}
