// Where to find Sports Fusion elsewhere.
//
// The brand marks are inline rather than imported: lucide dropped its brand icons, and
// four paths is a great deal less than a second icon dependency for four links.
//
// Every one of these leaves the site, so every one says so — `target="_blank"` with
// `rel="noreferrer"`, and an external-link affordance on the wider layouts. A link that
// silently replaces the app with Instagram is a link people stop trusting.

import { cn } from '../../lib/cn.js';
import { SOCIAL_LINKS } from '../../lib/links.js';

/* Brand marks. 24x24 viewBox, currentColor, so they take the surrounding text colour. */
const MARKS = {
  whatsapp: (
    <path
      fill="currentColor"
      d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24Zm-3.2 4.3c-.15 0-.4.06-.6.29-.21.22-.79.77-.79 1.88 0 1.1.81 2.17.92 2.32.11.15 1.57 2.4 3.8 3.36.53.23.95.37 1.27.47.53.17 1.02.15 1.4.09.43-.06 1.32-.54 1.5-1.06.19-.52.19-.97.13-1.06-.05-.09-.2-.15-.42-.26-.22-.11-1.31-.65-1.51-.72-.2-.08-.35-.11-.5.11-.15.22-.57.72-.7.87-.13.15-.26.17-.48.06-.22-.11-.93-.34-1.77-1.09-.66-.58-1.1-1.3-1.23-1.52-.13-.22-.02-.34.1-.45.1-.1.22-.26.33-.39.11-.13.15-.22.22-.37.08-.15.04-.28-.02-.39-.05-.11-.5-1.2-.68-1.65-.18-.43-.36-.37-.5-.38l-.42-.01Z"
    />
  ),
  instagram: (
    <>
      <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.4" cy="6.6" r="1.25" fill="currentColor" />
    </>
  ),
  tiktok: (
    <path
      fill="currentColor"
      d="M16.6 2h-2.9v13.2a2.5 2.5 0 1 1-2.1-2.47V9.75a5.6 5.6 0 1 0 5.02 5.57V8.9a6.6 6.6 0 0 0 3.83 1.22V7.2A3.72 3.72 0 0 1 16.6 3.6V2Z"
    />
  ),
  store: (
    <>
      <path
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"
        d="M3.2 7.4 4.6 3.6h14.8l1.4 3.8v1.1a2.6 2.6 0 0 1-4.45 1.84A2.6 2.6 0 0 1 12 10.5a2.6 2.6 0 0 1-4.35-.16A2.6 2.6 0 0 1 3.2 8.5Z"
      />
      <path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" d="M4.9 11.6v8.8h14.2v-8.8" />
      <path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" d="M9.7 20.4v-5.3h4.6v5.3" />
    </>
  ),
};

function Mark({ name, className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {MARKS[name] ?? MARKS.store}
    </svg>
  );
}

/**
 * A row of icon links. For a footer or a header, where space is tight and the marks
 * carry the meaning on their own.
 */
export function SocialRow({ className, size = 'md' }) {
  const box = size === 'sm' ? 'size-8' : 'size-9 pointer-coarse:size-11';
  const icon = size === 'sm' ? 'size-4' : 'size-[18px]';

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {SOCIAL_LINKS.map((link) => (
        <a
          key={link.key}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          title={link.label}
          aria-label={`${link.label} (opens in a new tab)`}
          className={cn(
            'grid place-items-center rounded-[var(--radius-md)] text-[var(--fg-secondary)]',
            'transition-colors hover:bg-[var(--bg-sunken)] hover:text-[var(--fg-primary)]',
            box
          )}
        >
          <Mark name={link.key} className={icon} />
        </a>
      ))}
    </div>
  );
}

/**
 * The same links as full-width rows, for a sheet or a page section where there is room
 * to say what each one is for.
 */
export function SocialList({ className, onNavigate }) {
  return (
    <div className={cn('space-y-1', className)}>
      {SOCIAL_LINKS.map((link) => (
        <a
          key={link.key}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-3 transition-colors hover:bg-[var(--bg-sunken)]"
        >
          <span
            className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)]"
            style={{ background: `${link.brand}1f`, color: link.brand }}
          >
            <Mark name={link.key} className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{link.label}</span>
            <span className="block truncate text-xs text-[var(--fg-secondary)]">{link.description}</span>
          </span>
          <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true">
            <path
              fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
            />
          </svg>
        </a>
      ))}
    </div>
  );
}

/**
 * The community band for the landing page: bigger targets, and the WhatsApp group given
 * the weight it actually has in this community.
 */
export function CommunityLinks({ className }) {
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {SOCIAL_LINKS.map((link) => (
        <a
          key={link.key}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="card card-interactive flex items-center gap-3 p-4"
        >
          <span
            className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)]"
            style={{ background: `${link.brand}1f`, color: link.brand }}
          >
            <Mark name={link.key} className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{link.short}</span>
            <span className="block truncate text-xs text-[var(--fg-secondary)]">{link.description}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

export default SocialRow;
