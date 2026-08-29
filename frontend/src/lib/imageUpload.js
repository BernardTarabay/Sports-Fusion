// Turning a file someone picked into something safe to store on a row.
//
// The whole point is that the result is a data URI. A venue badge has to be same-origin
// or the shared team-sheet export taints its canvas and produces nothing — so the file is
// read, downscaled, re-encoded, and stored inline rather than uploaded anywhere.
//
// Downscaling is not an optimisation here. A logo straight off a phone is a 3MB JPEG,
// which as base64 is 4MB of TEXT on a row that gets read on every game page. At 256px it
// is 10–25KB and still sharper than the 40px it will be drawn at.

/** Bigger than it is ever displayed, so it stays crisp on a retina export at 2x. */
const MAX_EDGE = 256;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/**
 * @param {File} file
 * @returns {Promise<{ dataUrl: string, width: number, height: number, bytes: number }>}
 */
export async function fileToLogoDataUrl(file) {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error('Use a PNG, JPEG, WebP or SVG');
  }
  // Generous: this is the file on disk, before downscaling. The stored result is tiny.
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('That file is over 8MB — try a smaller export of the logo');
  }

  // SVG is already small and resolution-independent, and rasterising it would throw away
  // the one thing it is good at. Passed through as-is.
  if (file.type === 'image/svg+xml') {
    const text = await file.text();
    // A logo has no business running anything. An inline <svg> becomes part of our own
    // document in the export, so a script or an external reference inside it would run
    // with our origin.
    if (/<script|onload=|xlink:href\s*=\s*["']https?:/i.test(text)) {
      throw new Error('That SVG contains scripts or remote references, so it cannot be used');
    }
    const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    return { dataUrl, width: MAX_EDGE, height: MAX_EDGE, bytes: dataUrl.length };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // PNG, not JPEG: these are logos on a coloured background, and JPEG both loses the
  // alpha channel and puts ringing artefacts around hard edges and lettering.
  const dataUrl = canvas.toDataURL('image/png');

  // The column caps at 400KB. A 256px PNG should be nowhere near it, but a photographic
  // logo with no flat colour can be, and failing here with a sentence beats a 422.
  if (dataUrl.length > 400_000) {
    throw new Error('That logo is too detailed to store inline — try a flatter version');
  }

  return { dataUrl, width, height, bytes: dataUrl.length };
}
