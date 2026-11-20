import { RequirementForm } from '../RequirementForm';
import { createRequirement } from '../form-actions';

export const metadata = { title: 'Новая потребность' };

export default function NewRequirementPage() {
  return (
    <>
      <h1>Новая потребность</h1>
      <p className="sub">
        У одного клиента может быть несколько потребностей одновременно — второй
        раз заводить его не нужно.
      </p>
      <div className="card">
        <RequirementForm action={createRequirement} mode="create" />
      </div>
    </>
  );
}
