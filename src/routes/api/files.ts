import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { chatFiles, conversations } from "../../db/schema/chat.ts";
import { eq } from "drizzle-orm";
import { env } from "../../config/env.ts";
import { isS3Enabled, buildS3Key, uploadBinary, downloadBinary, guessContentType } from "../../services/s3.ts";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const files = new Hono<AuthEnv>();
files.use("*", requireAuth);

const UPLOADS_DIR = path.resolve("./uploads");

async function ensureUploadsDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

// POST /api/files/upload
files.post("/upload", async (c) => {
  const user = c.get("user");
  try {
    const body = await c.req.parseBody();
    const file = body["file"] as File | undefined;
    const conversationId = body["conversation_id"] as string | undefined;
    if (!file) return c.json({ error: "No file provided" }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split(".").pop() ?? "bin").toLowerCase();
    const filename = `${crypto.randomUUID()}.${ext}`;
    const contentType = file.type || guessContentType(file.name);

    // Prefer S3 (the prod container's filesystem is ephemeral/read-only, so a
    // local write throws a bare 500). Store the S3 key in filePath with an "s3:"
    // marker; fall back to local disk in dev where S3 isn't configured.
    let storedPath = "";
    if (isS3Enabled) {
      const key = buildS3Key(conversationId || "chat", "chat-files", filename);
      try {
        await uploadBinary(key, buffer, contentType);
        storedPath = `s3:${key}`;
      } catch (err) {
        console.error("[files.upload] S3 upload failed, falling back to local:", (err as Error).message);
      }
    }
    if (!storedPath) {
      await ensureUploadsDir();
      await fs.writeFile(path.join(UPLOADS_DIR, filename), buffer);
      storedPath = `uploads/${filename}`;
    }

    // chatFiles row → the client references it via /api/files/:id. Requires a
    // real, owned conversation (FK). If it isn't persisted yet, fail clearly
    // instead of an opaque FK 500.
    let fileRecord = null;
    if (conversationId) {
      const [conv] = await db.select({ id: conversations.id, userId: conversations.userId })
        .from(conversations).where(eq(conversations.id, conversationId));
      if (!conv || conv.userId !== user.id) {
        return c.json({ error: "Conversation not found — send a message first, then attach the file." }, 400);
      }
      const [row] = await db.insert(chatFiles).values({
        conversationId,
        filePath: storedPath,
        originalFilename: file.name,
        fileType: contentType,
        fileSize: file.size,
      }).returning();
      fileRecord = row;
    }

    return c.json({
      id: fileRecord?.id ?? null,
      filename,
      originalName: file.name,
      fileType: contentType,
      fileSize: file.size,
      path: storedPath,
      url: fileRecord ? `/api/files/${fileRecord.id}` : undefined,
    });
  } catch (err) {
    console.error("[files.upload] failed:", err);
    return c.json({ error: `Upload failed: ${(err as Error).message || "server error"}` }, 500);
  }
});

// GET /api/files/:id — serve an uploaded chat file (so images persist in chat
// history across a reload). Auth: the requester must own the conversation.
files.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [cf] = await db.select().from(chatFiles).where(eq(chatFiles.id, id));
  if (!cf) return c.json({ error: "not found" }, 404);
  const [conv] = await db.select({ userId: conversations.userId }).from(conversations).where(eq(conversations.id, cf.conversationId));
  if (!conv || conv.userId !== user.id) return c.json({ error: "forbidden" }, 403);
  try {
    // S3-stored (filePath = "s3:<key>") vs legacy local disk.
    if (cf.filePath.startsWith("s3:")) {
      const { body, contentType } = await downloadBinary(cf.filePath.slice(3));
      return new Response(body, { headers: { "Content-Type": contentType || cf.fileType || "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
    }
    const buf = await fs.readFile(path.resolve(cf.filePath));
    return new Response(buf, { headers: { "Content-Type": cf.fileType || "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
  } catch (err) {
    console.error("[files.get] serve failed:", (err as Error).message);
    return c.json({ error: "file missing" }, 404);
  }
});

// GET /api/files/transcribe/:fileId — transcribe audio via OpenAI Whisper
files.get("/transcribe/:fileId", async (c) => {
  if (!env.OPENAI_API_KEY) {
    return c.json({ error: "OpenAI API key not configured" }, 503);
  }

  const { fileId } = c.req.param();
  const [fileRow] = await db
    .select()
    .from(chatFiles)
    .where(eq(chatFiles.id, fileId));

  if (!fileRow) return c.json({ error: "File not found" }, 404);

  const fullPath = path.resolve(fileRow.filePath);
  let fileData: Buffer;
  try {
    fileData = await fs.readFile(fullPath);
  } catch {
    return c.json({ error: "File not readable" }, 404);
  }

  // Call OpenAI Whisper
  const formData = new FormData();
  formData.append("file", new Blob([fileData], { type: fileRow.fileType ?? "audio/webm" }), fileRow.originalFilename);
  formData.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Whisper API error: ${err}` }, 500);
  }

  const data = (await res.json()) as { text: string };
  return c.json({ text: data.text, fileId });
});

export default files;
