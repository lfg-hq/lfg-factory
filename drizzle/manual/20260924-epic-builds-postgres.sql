ALTER TABLE project ADD COLUMN IF NOT EXISTS epic_builds_enabled boolean NOT NULL DEFAULT false;
