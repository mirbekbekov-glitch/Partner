import { signOut } from './auth-actions';

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="ghost">Выйти</button>
    </form>
  );
}
