CREATE TABLE IF NOT EXISTS venture_agreement (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 decision_id text REFERENCES venture_decision(id) ON DELETE SET NULL,
 version integer NOT NULL, status text DEFAULT 'awaiting_signatures' NOT NULL, structure text NOT NULL,
 equity_percent real, revenue_share_percent real, cap_multiple real, term_months integer,
 tokens_committed integer NOT NULL, body text NOT NULL,
 founder_user_id text, founder_signed_name text, founder_signed_at integer,
 lfg_user_id text, lfg_signed_name text, lfg_signed_at integer, activated_at integer,
 created_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_agreement_conv_idx ON venture_agreement (conversation_id, version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_agreement_message (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 agreement_id text NOT NULL REFERENCES venture_agreement(id) ON DELETE CASCADE,
 author_user_id text NOT NULL, side text NOT NULL, kind text NOT NULL, message text NOT NULL, proposed_terms text,
 created_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_agreement_msg_idx ON venture_agreement_message (agreement_id, created_at);
