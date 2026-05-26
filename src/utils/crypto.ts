/**
 * Symmetric encryption helper for at-rest secrets (agent env vars, etc).
 *
 * Uses AES-256-GCM when ENCRYPTION_KEY is configured. When not configured,
 * falls back to base64 with a "plain:" prefix so the app still runs in dev —
 * same convention used elsewhere in the codebase (see ai/tools/env-tools.ts).
 *
 * Storage format:
 *   "gcm:<iv_b64>:<tag_b64>:<ciphertext_b64>"   — encrypted
 *   "plain:<value_b64>"                         — unencrypted fallback
 *
 * The ENCRYPTION_KEY env var should be a 32-byte value (64 hex chars or any
 * string ≥32 chars). We derive a 32-byte key via SHA-256 so any input length works.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96 bits, GCM standard

function deriveKey(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  if (!env.ENCRYPTION_KEY) {
    console.warn("[crypto] ENCRYPTION_KEY not set — storing secret with base64 fallback. Set ENCRYPTION_KEY in production.");
    return `plain:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }

  const key = deriveKey(env.ENCRYPTION_KEY);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `gcm:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith("plain:")) {
    return Buffer.from(stored.slice(6), "base64").toString("utf8");
  }

  if (stored.startsWith("gcm:")) {
    if (!env.ENCRYPTION_KEY) {
      throw new Error("Secret was encrypted with ENCRYPTION_KEY but key is no longer set");
    }
    const parts = stored.slice(4).split(":");
    if (parts.length !== 3) throw new Error("Malformed encrypted secret");
    const iv = Buffer.from(parts[0]!, "base64");
    const tag = Buffer.from(parts[1]!, "base64");
    const ciphertext = Buffer.from(parts[2]!, "base64");

    const key = deriveKey(env.ENCRYPTION_KEY);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }

  // Legacy / unknown format: assume plain base64 (same as env-tools.ts "b64:")
  if (stored.startsWith("b64:")) {
    return Buffer.from(stored.slice(4), "base64").toString("utf8");
  }

  throw new Error("Unknown secret storage format");
}

/**
 * Generate a URL-safe random token (for webhook URLs, API keys, etc).
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}
