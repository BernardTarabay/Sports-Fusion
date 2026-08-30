// Where you play — and where else you are happy to play.
//
// A player is rarely one position. Someone is a right winger at heart who can fill in at
// centre mid and has played off the striker; the intake asked for one label, so the
// balancer saw "RW" and nothing else, and half a squad came through as "Anywhere".
//
// TAP TARGETS, NOT A SELECT.
//
// This is filled in once, on a phone, often standing at a pitch after scanning a QR code
// — frequently by somebody who has never used the app before. Three native `<select>`
// dropdowns is three modal pickers and a lot of scrolling. A grid of position chips is
// one tap each and shows the whole shape of a team while you choose.
//
// The first tap is your main position; the next two are alternates. Tapping your main
// again clears it and promotes the first alternate, so there is no separate "clear"
// affordance to explain.

import { cn } from '../../lib/cn.js';
import { POSITIONS } from '../../lib/catalogue.js';

// Laid out as a team sheet reads, back to front, so the grid looks like a pitch rather
// than an alphabetical list.
const ROWS = [
  { label: 'Goal', codes: ['GK'] },
  { label: 'Defence', codes: ['LB', 'CB', 'RB', 'LWB', 'RWB'] },
  { label: 'Midfield', codes: ['CDM', 'CM', 'CAM'] },
  { label: 'Attack', codes: ['LW', 'RW', 'CF', 'ST'] },
];

const labelOf = (code) => POSITIONS.find((p) => p.code === code)?.label ?? code;

/**
 * @param {string|null}  primary
 * @param {string[]}     secondary   up to two
 * @param {(next: { primary: string|null, secondary: string[] }) => void} onChange
 */
export function PositionPicker({ primary, secondary = [], onChange, max = 2, className }) {
  const chosen = [primary, ...secondary].filter(Boolean);

  const toggle = (code) => {
    if (code === primary) {
      // Clearing your main promotes the next one rather than leaving a hole.
      const [next, ...rest] = secondary;
      onChange({ primary: next ?? null, secondary: rest });
      return;
    }
    if (secondary.includes(code)) {
      onChange({ primary, secondary: secondary.filter((c) => c !== code) });
      return;
    }
    if (!primary) {
      onChange({ primary: code, secondary });
      return;
    }
    if (secondary.length >= max) return;
    onChange({ primary, secondary: [...secondary, code] });
  };

  const full = !!primary && secondary.length >= max;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-2.5">
        {ROWS.map((row) => (
          <div key={row.label}>
            <p className="eyebrow mb-1 text-[0.5625rem]">{row.label}</p>
            <div className="flex flex-wrap gap-1.5">
              {row.codes.map((code) => {
                const isPrimary = code === primary;
                const isSecondary = secondary.includes(code);
                const picked = isPrimary || isSecondary;
                // Not `disabled`: a disabled control gives no feedback when tapped, and
                // "why is this greyed out" is the question this screen cannot answer.
                // Dimmed and inert reads the same and stays announced.
                const spent = full && !picked;

                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggle(code)}
                    aria-pressed={picked}
                    aria-label={`${labelOf(code)}${isPrimary ? ', main position' : isSecondary ? ', also plays' : ''}`}
                    className={cn(
                      // 44px minimum: this is tapped with a thumb, outdoors.
                      'relative min-h-11 min-w-14 rounded-[var(--radius-md)] border px-3 text-sm font-semibold transition-colors active:scale-95',
                      isPrimary && 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]',
                      isSecondary && 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]',
                      !picked && 'border-[var(--border-default)] text-[var(--fg-secondary)]',
                      spent && 'opacity-40'
                    )}
                  >
                    {code}
                    {isPrimary && (
                      <span className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-[var(--fg-primary)] text-[0.5rem] font-bold text-[var(--bg-surface)]">
                        1
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Says what was chosen in words. The codes are a football shorthand not everyone
          reads instantly, and this is the one place it has to be unambiguous. */}
      <p className="text-xs text-[var(--fg-secondary)]" aria-live="polite">
        {chosen.length === 0
          ? 'Pick your main position. You can add two more you are happy to play.'
          : (
            <>
              <span className="font-semibold text-[var(--fg-primary)]">{labelOf(primary)}</span>
              {secondary.length > 0 && <> · also {secondary.map(labelOf).join(', ')}</>}
              {!full && secondary.length < max && (
                <span className="text-[var(--fg-muted)]">
                  {' '}· tap {max - secondary.length} more if you play {secondary.length ? 'another' : 'others'}
                </span>
              )}
            </>
          )}
      </p>
    </div>
  );
}

export default PositionPicker;
