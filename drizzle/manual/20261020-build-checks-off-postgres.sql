-- New projects start with validation and feature testing off; turn them on per project.
ALTER TABLE project ALTER COLUMN validation_enabled SET DEFAULT false;
ALTER TABLE project ALTER COLUMN feature_testing_enabled SET DEFAULT false;

-- OPTIONAL, not applied automatically: also switch existing projects off.
-- UPDATE project SET validation_enabled = false, feature_testing_enabled = false;
