ALTER TABLE project ADD COLUMN validation_enabled integer NOT NULL DEFAULT 1;
ALTER TABLE project ADD COLUMN feature_testing_enabled integer NOT NULL DEFAULT 1;
