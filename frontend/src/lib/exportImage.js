// Turning the pitch into a picture you can paste into WhatsApp.
//
// WHY THIS IS NOT THREE LINES
//
// Serialising an <svg> and drawing it to a canvas loses everything the browser was doing
// for it. The pitch is styled with CSS custom properties -- `fill="var(--pitch)"`,
// `stroke="var(--line)"` -- and those are resolved against the document. An SVG loaded
// into an <img> is a separate document with no stylesheet and no :root, so every one of
// them falls back to transparent and the export comes out as a blank rectangle with a
// few stray shapes.
//
// So the styles have to be baked in: walk the live nodes, read what the browser actually
// computed, and write those values onto the clone as plain attributes.
//
// The canvas is also tainted by anything cross-origin. There is nothing external in the
// pitch, but avatars could arrive from elsewhere later, so `toBlob` is wrapped and the
// failure is reported rather than thrown as a SecurityError nobody can act on.

/**
 * Properties worth copying. Copying all of them produces megabytes of style attributes.
 *
 * `stop-color` is the one that is easy to forget and impossible to miss once it is
 * wrong. The pitch surface is a linearGradient whose stops are `var(--pitch-turf-a)`,
 * and leaving it out of this list did not break the export -- it produced a perfectly
 * valid PNG that was 86% black, because an unresolved gradient stop falls back to black
 * rather than failing. Anything painted through <defs> needs its properties here too.
 *
 * `color` matters for the same reason one step removed: anything using `currentColor`
 * resolves against it.
 */
const PAINT = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'color', 'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing',
  'text-anchor', 'dominant-baseline',
];

/**
 * Copy computed paint from the live tree onto the clone.
 *
 * Walked in parallel rather than by selector, because the pitch has many identical
 * elements and matching them up any other way is guesswork.
 */
function inlineStyles(liveRoot, cloneRoot) {
  const live = [liveRoot, ...liveRoot.querySelectorAll('*')];
  const clone = [cloneRoot, ...cloneRoot.querySelectorAll('*')];

  for (let i = 0; i < live.length; i += 1) {
    const node = clone[i];
    if (!node || node.nodeType !== 1) continue;
    const computed = getComputedStyle(live[i]);

    let css = '';
    for (const prop of PAINT) {
      const value = computed.getPropertyValue(prop);
      // `none` and empty are meaningful defaults already; writing them adds noise.
      if (value && value !== 'none' && value !== 'normal') css += `${prop}:${value};`;
    }
    if (css) node.setAttribute('style', css);

    // Animations are mid-flight when the snapshot is taken, and a marker frozen at 40%
    // of its entrance is a marker in the wrong place with the wrong opacity.
    node.style.animation = 'none';
    node.style.transition = 'none';
  }
}

/**
 * Render an <svg> element to a PNG blob.
 *
 * @param {SVGElement} svg
 * @param {object} [options]
 * @param {number} [options.scale]       pixel density; 2 is crisp on a phone screen
 * @param {string} [options.background]  painted behind the SVG, since PNG has no page
 * @param {number} [options.padding]     breathing room, in CSS pixels
 */
export async function svgToPngBlob(svg, {
  scale = 2, background = '#0A0F0D', padding = 24, badge = null, caption = null,
} = {}) {
  const box = svg.getBoundingClientRect();
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  if (!width || !height) throw new Error('The pitch is not on screen to export');

  const clone = svg.cloneNode(true);
  inlineStyles(svg, clone);

  // An SVG in an <img> has no layout to inherit, so it needs explicit dimensions and a
  // viewBox, or it renders at whatever the browser guesses.
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const source = new XMLSerializer().serializeToString(clone);
  // A data URI, not a blob URL: Safari refuses to draw a blob-backed SVG to a canvas.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not draw the pitch'));
    img.src = url;
  });

  // A strip above the pitch for the venue badge and the fixture line, when there is one.
  // Drawn on the canvas rather than into the SVG: the badge is a raster image and the
  // caption is plain text, and neither needs to survive as vector geometry.
  const header = badge || caption ? 64 : 0;

  const canvas = document.createElement('canvas');
  canvas.width = (width + padding * 2) * scale;
  canvas.height = (height + padding * 2 + header) * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width + padding * 2, height + padding * 2 + header);

  if (header) {
    let x = padding;
    if (badge) {
      // SAME-ORIGIN, which is what keeps this working.
      //
      // Drawing a cross-origin image taints the canvas: toBlob() then throws a
      // SecurityError and there is no picture at all. The badge used to be a data URI --
      // same-origin by definition -- which solved that and cost 50-60 KB on every game in
      // every list (see backend/src/modules/venues/routes.js). It now arrives as
      // `/api/venues/:id/logo`, a relative path, and both deployments serve /api from the
      // web origin, so it is still same-origin and the canvas is still clean.
      //
      // No crossOrigin attribute on purpose: setting it would turn a same-origin fetch
      // into a CORS one and reintroduce the very failure this is avoiding.
      const logo = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = badge;
      });
      if (logo) {
        const box = 44;
        const ratio = Math.min(box / logo.width, box / logo.height);
        const w = logo.width * ratio;
        const h = logo.height * ratio;
        ctx.drawImage(logo, x + (box - w) / 2, 12 + (box - h) / 2, w, h);
        x += box + 12;
      }
    }
    if (caption) {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 17px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(caption, x, 34);
    }
  }

  ctx.drawImage(image, padding, padding + header, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not build the image'))),
      'image/png'
    );
  });
}

/**
 * Hand a PNG to whatever the device uses to share.
 *
 * On a phone this opens the share sheet with WhatsApp in it, which is the entire point:
 * the admin was screenshotting the screen and cropping it by hand. On a desktop browser
 * there is no file sharing, so it downloads and the admin drags it into WhatsApp Web.
 *
 * @returns {'shared'|'downloaded'|'cancelled'}
 */
export async function sharePng(blob, { filename = 'sports-fusion.png', title, text } = {}) {
  const file = new File([blob], filename, { type: 'image/png' });

  // canShare({files}) is the only reliable test. `navigator.share` exists on desktop
  // Chrome but rejects files, so feature-detecting the function alone sends the admin
  // into a dialog that cannot do what they asked.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      // Dismissing the sheet is a decision, not a failure. Falling through to a download
      // would drop a file in their downloads folder they did not ask for.
      if (err.name === 'AbortError') return 'cancelled';
      // Anything else: fall through and at least give them the file.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking immediately cancels the download in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

/** A filename someone can find again in their downloads folder. */
export function exportFilename(game) {
  const when = game?.kickoffAt ? new Date(game.kickoffAt) : new Date();
  const date = when.toISOString().slice(0, 10);
  const where = (game?.districtName ?? 'sports-fusion')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${where}-${date}.png`;
}
