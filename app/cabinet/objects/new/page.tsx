import { ObjectForm } from '../ObjectForm';
import { createObject } from '../form-actions';

export const metadata = { title: 'Новый объект' };

export default function NewObjectPage() {
  return (
    <>
      <h1>Новый объект</h1>
      <p className="sub">
        Объект, собственник и мандат заводятся одной операцией: если что-то не
        пройдёт проверку, не создастся ничего.
      </p>
      <div className="card">
        <ObjectForm action={createObject} mode="create" />
      </div>
    </>
  );
}
