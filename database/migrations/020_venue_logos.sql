-- 020_venue_logos.sql
-- Venue badges, on the team sheet that goes into WhatsApp.

-- Held inline, as a data URI, not as a link to somewhere else.
--
-- The reason is the export. The shared team sheet is produced by drawing the pitch onto a
-- canvas, and a canvas that has drawn a cross-origin image is tainted: toBlob() throws a
-- SecurityError and there is no picture at all. A logo hosted on the venue's own website
-- would therefore break the single feature the logo exists for.
--
-- A data URI is same-origin by definition, needs no file storage, no CDN, no signed URLs
-- and no cleanup when a venue is deleted. The upload path downscales to 256px before
-- encoding, which puts a badge at 10-25 KB -- small enough that a few hundred venues cost
-- less than one photograph.
--
-- TEXT rather than BYTEA because it is consumed as an <image href> and as a CSS url(),
-- both of which want the string form. If venues ever number in the thousands this wants
-- moving to object storage with a CORS policy that permits canvas reads.
ALTER TABLE venues ADD COLUMN logo_url TEXT;

-- A guard, not a validator: it will not tell you the base64 is a valid PNG, but it does
-- stop a path or an http:// link being stored in a column the export cannot use.
ALTER TABLE venues ADD CONSTRAINT venues_logo_is_inline
  CHECK (logo_url IS NULL OR logo_url ~ '^data:image/(png|jpeg|webp|svg\+xml);');

COMMENT ON COLUMN venues.logo_url IS
  'Inline data URI. Must be same-origin or the shared team-sheet export taints its canvas.';
