import { ContactForm } from '../ContactForm';
import { createContact } from '../actions';

export const metadata = { title: 'Новый контакт' };

export default function NewContactPage() {
  return (
    <>
      <h1>Новый контакт</h1>
      <p className="sub">
        Один человек — одна запись. Введите телефон, и мы проверим, нет ли его уже
        в базе: тогда достаточно добавить человеку нужную роль.
      </p>
      <div className="card">
        <ContactForm action={createContact} mode="create" />
      </div>
    </>
  );
}
