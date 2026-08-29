// The mark.
//
// The company logo, as a raster image. It arrived as a 447px JPEG, so it is drawn rather
// than inlined as SVG -- which means it cannot take `currentColor` and does not recolour
// with the theme. It carries its own near-black background, which reads correctly in both
// light and dark, but a vector version would be better: crisper at 512px on a home
// screen, and able to invert.
//
// `alt=""` throughout: the mark always sits next to the words "SPORTS FUSION", and a
// screen reader announcing the name twice is noise.

import { cn } from '../../lib/cn.js';

const LOGO_SRC = '/icon-512.png';

export function LogoMark({ className, ...props }) {
  return (
    <img
      src={LOGO_SRC}
      alt=""
      // The source is square, so object-contain keeps it square at any box it is given.
      className={cn('shrink-0 rounded-[var(--radius-sm)] object-contain', className)}
      {...props}
    />
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
