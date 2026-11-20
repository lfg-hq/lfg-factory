-- A comment reply the agent wrote on the user's behalf (shown as the AI agent, not as them).
ALTER TABLE document_comment ADD COLUMN IF NOT EXISTS by_agent boolean NOT NULL DEFAULT false;
