// The mark.
//
// Two arcs meeting: the centre circle of a pitch, split and fused. It reads at 20px in a
// bottom bar and at 200px on the landing page, and it is a shape rather than a football
// clip-art -- the identity should survive being printed in one colour on a shirt.

import { cn } from '../../lib/cn.js';

export function LogoMark({ className, ...props }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('shrink-0', className)} aria-hidden="true" {...props}>
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      {/* Two halves of a centre circle, offset -- the "fusion". */}
      <path
        d="M16 3.5a12.5 12.5 0 0 0 0 25"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        d="M16 6.5a9.5 9.5 0 0 1 0 19"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ className, compact = false, showMark = true }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-[var(--fg-primary)]', className)}>
      {showMark && <LogoMark className="h-full w-auto" />}
      {!compact && (
        <span className="display text-[1.35em] leading-none tracking-tight">
          SPORTS<span className="text-[var(--accent)]">FUSION</span>
        </span>
      )}
    </span>
  );
}

export default Logo;
