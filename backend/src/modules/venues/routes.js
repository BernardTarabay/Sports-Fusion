// Venue badges, served as images rather than shipped inside every JSON payload.
//
// WHY THIS ROUTE EXISTS
//
// The badge is stored inline, as a data URI, and migration 020 explains why: the shared
// team sheet is drawn onto a canvas, and a canvas that has drawn a cross-origin image
// cannot be exported. Storing it inline solved that -- and created a much larger problem,
// because `venues.logo_url` was then selected into the game projection and went out with
// EVERY game in EVERY list. Measured on the development database: four games, three of
// which share one venue, produced a 238 KB response for what is 2 KB of actual fixture
// data. The schema permits 400 KB per badge and the list endpoint returns up to 100
// games, so the ceiling was tens of megabytes per page load, uncacheable, on the Beirut
// mobile connections this app is written for.
//
// So the bytes come from here instead. The JSON carries a path; the browser fetches the
// image once and caches it.
//
// STILL SAME-ORIGIN. Both deployments put the API under /api on the web origin -- Vercel
// rewrites in production, the Vite proxy in development -- so `/api/venues/:id/logo` is
// same-origin to the browser and the canvas export keeps working. That is the whole
// constraint migration 020 was protecting, and it is preserved.

import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { query } from '../../database/pool.js';
import { validate, asyncHandler } from '../../middleware/validate.js';
import { NotFoundError } from '../../lib/errors.js';

const router = Router();

// The set the column's CHECK constraint permits, mapped to what to send back.
const CONTENT_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  'svg+xml': 'image/svg+xml',
};

/** Split `data:image/png;base64,AAAA` into a content type and the raw bytes. */
function decodeDataUri(value) {
  const match = /^data:image\/([a-z+]+);base64,(.+)$/is.exec(value ?? '');
  if (!match) return null;
  const contentType = CONTENT_TYPES[match[1].toLowerCase()];
  if (!contentType) return null;
  try {
    return { contentType, body: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

router.get(
  '/:id/logo',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT logo_url FROM venues WHERE id = $1', [req.params.id]);
    const image = rows[0] ? decodeDataUri(rows[0].logo_url) : null;
    if (!image) throw new NotFoundError('Venue badge');

    // Strong validator over the bytes, so a badge that is replaced with an identical
    // image does not invalidate anyone's cache, and one that changes does.
    const etag = `"${createHash('sha1').update(image.body).digest('base64url')}"`;

    res.set({
      'Content-Type': image.contentType,
      // A day in the browser, and the URL carries the row's updated_at, so a replaced
      // badge is a different URL and appears immediately. `immutable` would be wrong:
      // the version token is advisory and callers may drop it.
      'Cache-Control': 'public, max-age=86400',
      ETag: etag,
      // Nothing here varies by who is asking; this is deliberately not behind auth,
      // because it is drawn on the public game page.
      'Cross-Origin-Resource-Policy': 'same-site',
      'X-Content-Type-Options': 'nosniff',
      // An SVG badge is an untrusted document; served inline it would run script on the
      // API origin. It is only ever painted through <img>, where script does not run,
      // but the header makes that guarantee independent of how a caller uses it.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });

    if (req.get('if-none-match') === etag) return res.status(304).end();
    return res.send(image.body);
  })
);

export default router;
