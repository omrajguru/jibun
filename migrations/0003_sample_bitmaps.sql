-- Store traced-glyph bitmaps (a few KB each) in D1 instead of one S3 object per
-- glyph, so uploading a full page needs no outbound storage requests.
ALTER TABLE samples ADD COLUMN bitmap BLOB;
