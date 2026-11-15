CREATE TABLE IF NOT EXISTS eval_suite (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  name text NOT NULL DEFAULT 'Untitled evals',
  description text NOT NULL DEFAULT '',
  agent_prompt text NOT NULL DEFAULT '',
  tools text NOT NULL DEFAULT '[]',
  scenarios text NOT NULL DEFAULT '[]',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_suite_project_idx ON eval_suite(project_id);
CREATE TABLE IF NOT EXISTS eval_run (
  id text PRIMARY KEY,
  suite_id text NOT NULL REFERENCES eval_suite(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  models text NOT NULL DEFAULT '[]',
  judge_model text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  created_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);
CREATE INDEX IF NOT EXISTS eval_run_suite_idx ON eval_run(suite_id);
CREATE TABLE IF NOT EXISTS eval_result (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES eval_run(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  scenario text NOT NULL DEFAULT '{}',
  model_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  score integer,
  transcript text NOT NULL DEFAULT '[]',
  verdict text NOT NULL DEFAULT '{}',
  error text,
  turns integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_result_run_idx ON eval_result(run_id);
