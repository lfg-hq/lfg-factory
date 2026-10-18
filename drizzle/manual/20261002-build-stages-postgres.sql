ALTER TABLE project ADD COLUMN IF NOT EXISTS validation_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE project ADD COLUMN IF NOT EXISTS feature_testing_enabled boolean NOT NULL DEFAULT true;
