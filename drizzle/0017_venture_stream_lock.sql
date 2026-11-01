CREATE UNIQUE INDEX IF NOT EXISTS "venture_msg_active_idx" ON "venture_message" ("conversation_id") WHERE "role" = 'assistant' AND "status" = 'started';
