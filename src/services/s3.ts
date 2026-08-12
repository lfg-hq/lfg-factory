/**
 * S3 storage service for project files.
 * Mirrors the Django ProjectFile.save_content() / file_content behaviour:
 *   - Key pattern: project_files/{internalProjectId}/{fileType}/{name}
 *   - When FILE_STORAGE_TYPE=s3: upload to S3, store s3Key in DB, clear content column
 *   - When FILE_STORAGE_TYPE=local: skip S3, content lives in DB
 *   - getContent(): if s3Key is set → fetch from S3; else → return DB content
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "../config/env.ts";

// ── Local filesystem storage (FILE_STORAGE_TYPE=local) ────────────────
// When S3 is not enabled, binary uploads are written under LOCAL_STORAGE_DIR
// (default ./data/uploads — must be writable by the process) and served back
// over HTTP at /storage/<key> (see the route mounted in src/index.ts).

const LOCAL_DIR = resolve(env.LOCAL_STORAGE_DIR);

/** Absolute on-disk path for a storage key, guarded against path traversal. */
function localPath(key: string): string {
  const p = resolve(join(LOCAL_DIR, key));
  if (p !== LOCAL_DIR && !p.startsWith(LOCAL_DIR + "/")) {
    throw new Error("Invalid storage key (path traversal)");
  }
  return p;
}

async function localWrite(key: string, body: Buffer | Uint8Array | string): Promise<void> {
  const p = localPath(key);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, body as any);
}

function localPublicUrl(key: string): string {
  const base = (env.APP_URL || env.BETTER_AUTH_URL || "").replace(/\/+$/, "");
  return `${base}/storage/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// ── Client (lazy-initialised so non-S3 deployments pay no cost) ───────

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: env.AWS_S3_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

export const isS3Enabled =
  env.FILE_STORAGE_TYPE === "s3" &&
  !!env.AWS_S3_BUCKET_NAME &&
  !!env.AWS_ACCESS_KEY_ID &&
  !!env.AWS_SECRET_ACCESS_KEY;

// ── Key builder ───────────────────────────────────────────────────────
// Matches Django: project_files/{project_id}/{file_type}/{name}

export function buildS3Key(projectId: string, fileType: string, name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._\- ]/g, "_");
  return `project_files/${projectId}/${fileType}/${safeName}`;
}

// ── Upload ────────────────────────────────────────────────────────────

export async function uploadFile(key: string, content: string): Promise<void> {
  if (!isS3Enabled) return localWrite(key, content);
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: content,
      ContentType: "text/plain; charset=utf-8",
    })
  );
}

/**
 * Binary upload — for non-text Data Room files (xlsx, png, pdf, mp4, ...).
 * Caller supplies the ContentType so downloads serve with the right mime.
 */
export async function uploadBinary(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  if (!isS3Enabled) return localWrite(key, body);
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

// ── Download ──────────────────────────────────────────────────────────

export async function downloadFile(key: string): Promise<string> {
  if (!isS3Enabled) return fs.readFile(localPath(key), "utf-8").catch(() => "");
  const res = await getClient().send(
    new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
    })
  );
  if (!res.Body) return "";
  // Bun / Node streaming body → string
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Binary download — returns the raw bytes + contentType so the route can
 * stream them back with the right headers.
 */
export async function downloadBinary(
  key: string
): Promise<{ body: Buffer; contentType: string | null }> {
  if (!isS3Enabled) {
    const body = await fs.readFile(localPath(key)).catch(() => Buffer.alloc(0));
    return { body, contentType: guessContentType(key) };
  }
  const res = await getClient().send(
    new GetObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
    })
  );
  if (!res.Body) return { body: Buffer.alloc(0), contentType: res.ContentType ?? null };
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), contentType: res.ContentType ?? null };
}

// ── Data Room key builder ─────────────────────────────────────────────
// Separate namespace from project_files/ so we don't collide.
export function buildAgentDataRoomKey(agentRowId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._\- ]/g, "_");
  return `agents/${agentRowId}/data/${safeName}`;
}

// ── Best-effort MIME guesser for Data Room uploads ────────────────────
const EXT_TO_MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

export function guessContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

// ── Presigned URLs ────────────────────────────────────────────────────
// Short-lived signed URL for GET. The sandbox can curl this directly,
// bypassing the host's base64-over-SSH bottleneck for any size of file.

export async function getPresignedGetUrl(
  key: string,
  expiresInSec = 600
): Promise<string> {
  // Local mode: no signing — serve via the /storage/<key> HTTP route instead.
  if (!isS3Enabled) return localPublicUrl(key);
  // Cast: s3-request-presigner bundles its own @smithy/types; the duplicate
  // makes TS think the S3Client/Command types are incompatible at the
  // structural level. They're runtime-compatible.
  return getSignedUrl(
    getClient() as any,
    new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }) as any,
    { expiresIn: expiresInSec }
  );
}

// ── Delete ────────────────────────────────────────────────────────────

export async function deleteFile(key: string): Promise<void> {
  if (!isS3Enabled) {
    await fs.rm(localPath(key), { force: true });
    return;
  }
  await getClient().send(
    new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET_NAME,
      Key: key,
    })
  );
}

// ── High-level helpers used by routes + tools ─────────────────────────

/**
 * Save file content.
 * Returns `{ s3Key, dbContent }` — exactly one will be non-null.
 * If S3 is enabled and upload succeeds, s3Key is set and dbContent is null.
 * If S3 is disabled or upload fails, dbContent is set and s3Key is null.
 */
export async function saveContent(
  projectId: string,
  fileType: string,
  name: string,
  content: string
): Promise<{ s3Key: string | null; dbContent: string | null }> {
  if (!isS3Enabled) {
    return { s3Key: null, dbContent: content };
  }

  const key = buildS3Key(projectId, fileType, name);
  try {
    await uploadFile(key, content);
    return { s3Key: key, dbContent: null };
  } catch (err) {
    console.error("[S3] Upload failed, falling back to DB:", err);
    return { s3Key: null, dbContent: content };
  }
}

/**
 * Retrieve file content — from S3 if s3Key is set, otherwise from the DB value.
 */
export async function getContent(
  s3Key: string | null | undefined,
  dbContent: string | null | undefined
): Promise<string> {
  if (s3Key) {
    try {
      return await downloadFile(s3Key);
    } catch (err) {
      console.error("[S3] Download failed, falling back to DB:", err);
    }
  }
  return dbContent ?? "";
}

/**
 * Delete file from S3 (no-op if S3 disabled or key missing).
 */
export async function deleteContent(s3Key: string | null | undefined): Promise<void> {
  if (isS3Enabled && s3Key) {
    try {
      await deleteFile(s3Key);
    } catch (err) {
      console.error("[S3] Delete failed:", err);
    }
  }
}
