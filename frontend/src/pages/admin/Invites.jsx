// Admin invites page. Thin: the panel is a component because the same thing belongs on a
// game's Players tab, where "invite the group to THIS game" is the natural action.
import { InvitePanel } from '../../components/admin/InvitePanel.jsx';

export default function AdminInvites() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="display mb-1 text-3xl">Invites</h1>
      <p className="mb-6 text-sm text-[var(--fg-secondary)]">
        How a WhatsApp group becomes a player database.
      </p>
      <InvitePanel />
    </div>
  );
}
