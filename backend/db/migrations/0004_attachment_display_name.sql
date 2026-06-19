-- Allow a user-friendly display name for attachments (separate from the real
-- filename stored in original_name / object_key). Shown in the UI when present;
-- falls back to original_name otherwise. Also used for renamed text documents.
ALTER TABLE attachments ADD COLUMN display_name TEXT;
