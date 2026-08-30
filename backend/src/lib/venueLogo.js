// Where a venue's badge is served from.
//
// Its own file, with no imports, because both the games module and the districts module
// need it and the districts module already reads games. Putting it in either one would
// make that a cycle.

/**
 * A path, not the bytes.
 *
 * The query string is the venue row's own `updated_at`, so replacing a badge changes the
 * URL and the old one falls out of every cache -- which is what lets the response itself
 * be cached for a day instead of being revalidated on every fixture card.
 *
 * Same-origin on purpose. The shared team sheet is drawn onto a canvas, and a canvas that
 * has drawn a cross-origin image cannot be exported (see migration 020). Both deployments
 * put the API under /api on the web origin -- Vercel rewrites in production, the Vite
 * proxy in development -- so a path here is same-origin in the browser and the export
 * keeps working.
 */
export function venueLogoPath(venueId, updatedAt) {
  const v = updatedAt ? new Date(updatedAt).getTime().toString(36) : '0';
  return `/api/venues/${venueId}/logo?v=${v}`;
}
