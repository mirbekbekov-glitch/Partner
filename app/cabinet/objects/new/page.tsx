import { ObjectForm } from '../ObjectForm';
import { createObject } from '../form-actions';
import { currentAgent } from '@/lib/db/session';

export const metadata = { title: 'Новый объект' };

export default async function NewObjectPage() {
  // Свой номер подставляется в форму: агент вписывает его один раз, а
  // дальше видит в каждой карточке уже заполненным.
  const me = await currentAgent();
  return (
    <>
      <h1>Новый объект</h1>
      <p className="sub">
        Объект, собственник и мандат заводятся одной операцией: если что-то не
        пройдёт проверку, не создастся ничего.
      </p>
      <div className="card">
        <ObjectForm action={createObject} mode="create" agentPhone={me?.phone ?? null} />
      </div>
    </>
  );
}
