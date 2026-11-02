import { redirect } from 'next/navigation';

/** Settings were folded into Alert settings; old links land there. */
export default function SettingsPage() {
  redirect('/alerts');
}
