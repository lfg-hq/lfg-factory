/**
 * Agent Secrets — per-agent encrypted key/value store
 *
 * Lets a user attach arbitrary API keys / tokens / service account JSONs
 * to an agent without requiring a Composio toolkit. The agent sandbox
 * receives these as environment variables (and a /root/.env file), so any
 * SDK or CLI inside the sandbox can pick them up.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { agents, agentSecrets } from "../db/schema/agents.ts";
import { encryptSecret, decryptSecret } from "../utils/crypto.ts";

export interface AgentSecret {
  id: string;
  key: string;
  description: string | null;
  service: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DecryptedSecret {
  key: string;
  value: string;
  description: string | null;
  service: string | null;
}

function assertValidKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid secret key "${key}" — must be SCREAMING_SNAKE_CASE (uppercase letters, digits, underscores; start with a letter)`
    );
  }
}

async function getAgentRowId(agentId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.agentId, agentId), eq(agents.userId, userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function listSecrets(
  agentId: string,
  userId: string
): Promise<AgentSecret[]> {
  const rowId = await getAgentRowId(agentId, userId);
  if (!rowId) return [];

  const rows = await db
    .select({
      id: agentSecrets.id,
      key: agentSecrets.key,
      description: agentSecrets.description,
      service: agentSecrets.service,
      createdAt: agentSecrets.createdAt,
      updatedAt: agentSecrets.updatedAt,
    })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, rowId));

  return rows;
}

export async function upsertSecret(
  agentId: string,
  userId: string,
  input: { key: string; value: string; description?: string; service?: string }
): Promise<AgentSecret> {
  assertValidKey(input.key);
  const rowId = await getAgentRowId(agentId, userId);
  if (!rowId) throw new Error("Agent not found");

  const encrypted = encryptSecret(input.value);

  // Upsert by (agentId, key)
  const [existing] = await db
    .select()
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, rowId), eq(agentSecrets.key, input.key)))
    .limit(1);

  if (existing) {
    const updated = await db
      .update(agentSecrets)
      .set({
        valueEncrypted: encrypted,
        description: input.description ?? existing.description,
        service: input.service ?? existing.service,
        updatedAt: new Date(),
      })
      .where(eq(agentSecrets.id, existing.id))
      .returning();
    const r = updated[0]!;
    return {
      id: r.id,
      key: r.key,
      description: r.description,
      service: r.service,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  const inserted = await db
    .insert(agentSecrets)
    .values({
      agentId: rowId,
      key: input.key,
      valueEncrypted: encrypted,
      description: input.description ?? null,
      service: input.service ?? null,
    })
    .returning();
  const r = inserted[0]!;
  return {
    id: r.id,
    key: r.key,
    description: r.description,
    service: r.service,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function deleteSecret(
  agentId: string,
  userId: string,
  secretId: string
): Promise<boolean> {
  const rowId = await getAgentRowId(agentId, userId);
  if (!rowId) return false;

  const deleted = await db
    .delete(agentSecrets)
    .where(and(eq(agentSecrets.id, secretId), eq(agentSecrets.agentId, rowId)))
    .returning();
  return deleted.length > 0;
}

/**
 * Load + decrypt all secrets for an agent. Used at sandbox injection time.
 * Takes the internal agent row id (not the public agentId uuid).
 */
export async function loadDecryptedSecretsByRowId(
  agentRowId: string
): Promise<DecryptedSecret[]> {
  const rows = await db
    .select()
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentRowId));

  const results: DecryptedSecret[] = [];
  for (const row of rows) {
    try {
      results.push({
        key: row.key,
        value: decryptSecret(row.valueEncrypted),
        description: row.description,
        service: row.service,
      });
    } catch (err) {
      console.error(`[agent-secrets] Failed to decrypt ${row.key}:`, (err as Error).message);
    }
  }
  return results;
}
