-- td-92bdfe: archive a trip for future reference. NULL = active. Archived
-- trips keep all their data and stay fully readable; they just move out of
-- the main list into a collapsed Archived section.
ALTER TABLE trips ADD COLUMN archived_at TIMESTAMPTZ;
