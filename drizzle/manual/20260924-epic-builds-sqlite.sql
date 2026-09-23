-- Run once, or use drizzle-kit push to add the schema field.
ALTER TABLE project ADD COLUMN epic_builds_enabled integer NOT NULL DEFAULT 0;
