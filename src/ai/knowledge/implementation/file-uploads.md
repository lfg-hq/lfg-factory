# File Uploads

## When to Use This

Use these patterns when you need to accept file uploads in your application — whether that means storing files locally during development, uploading directly to S3 in production, resizing images, or building a drag-and-drop file picker in React.

## Quick Start

### Dependencies

```bash
# Multer (local/memory uploads)
npm install multer
npm install -D @types/multer

# AWS S3
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Image resizing
npm install sharp

# Validation helpers
npm install mime-types
npm install -D @types/mime-types

# React drag-and-drop (optional UI lib)
npm install react-dropzone
```

### Environment Variables

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET_NAME=my-app-uploads
S3_PUBLIC_URL=https://my-app-uploads.s3.amazonaws.com
MAX_FILE_SIZE_MB=10
```

---

## Patterns

### 1. S3 Presigned URL — Server-Side Generation

```typescript
// src/lib/s3.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import path from 'path';

const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME!;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB ?? 10) * 1024 * 1024;

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

export interface PresignedUploadUrl {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  expiresAt: Date;
}

export async function generatePresignedUploadUrl(opts: {
  contentType: string;
  contentLength: number;
  folder?: string;
  filename?: string;
}): Promise<PresignedUploadUrl> {
  const { contentType, contentLength, folder = 'uploads', filename } = opts;

  if (!ALLOWED_TYPES[contentType]) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`File too large. Max size: ${process.env.MAX_FILE_SIZE_MB}MB`);
  }

  const ext = ALLOWED_TYPES[contentType];
  const key = `${folder}/${randomUUID()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
    // Enforce content type on upload to prevent type spoofing
    Metadata: {
      originalFilename: filename ?? 'unknown',
    },
  });

  const expiresIn = 300; // 5 minutes
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn });

  return {
    uploadUrl,
    key,
    publicUrl: `${process.env.S3_PUBLIC_URL}/${key}`,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export async function deleteS3Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function generatePresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn });
}
```

---

### 2. Presigned URL API Endpoint (Express)

```typescript
// src/routes/uploads.ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../lib/route-helpers';
import { requireAuth } from '../middleware/auth';
import { generatePresignedUploadUrl } from '../lib/s3';

export const uploadsRouter = Router();

const presignSchema = z.object({
  contentType: z.string(),
  contentLength: z.number().int().positive(),
  filename: z.string().optional(),
  folder: z.enum(['avatars', 'attachments', 'documents']).default('attachments'),
});

// POST /api/v1/uploads/presign
uploadsRouter.post(
  '/presign',
  requireAuth,
  validate(presignSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof presignSchema>;

    const result = await generatePresignedUploadUrl({
      contentType: body.contentType,
      contentLength: body.contentLength,
      folder: body.folder,
      filename: body.filename,
    });

    res.json({ data: result });
  })
);
```

---

### 3. Multer — Local/Memory Upload Middleware

```typescript
// src/lib/multer.ts
import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import { Request } from 'express';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB ?? 10) * 1024 * 1024;

// Disk storage (development / self-hosted)
export const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, './uploads'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  fileFilter: (_req: Request, file, cb: FileFilterCallback) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
  limits: { fileSize: MAX_FILE_SIZE },
});

// Memory storage (for processing before uploading to S3/cloud)
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req: Request, file, cb: FileFilterCallback) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
  limits: { fileSize: MAX_FILE_SIZE },
});

// Usage in a route:
// router.post('/avatar', requireAuth, memoryUpload.single('file'), asyncHandler(uploadAvatar));
```

---

### 4. Image Resize with Sharp Before S3 Upload

```typescript
// src/lib/image.ts
import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION! });

export interface ResizeOptions {
  width: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  format?: 'jpeg' | 'png' | 'webp';
  quality?: number;
}

export async function resizeAndUpload(
  buffer: Buffer,
  folder: string,
  opts: ResizeOptions = { width: 800, format: 'webp', quality: 80 }
): Promise<{ key: string; publicUrl: string; size: number }> {
  const { width, height, fit = 'cover', format = 'webp', quality = 80 } = opts;

  const processed = await sharp(buffer)
    .resize(width, height, { fit })
    .toFormat(format, { quality })
    .toBuffer();

  const key = `${folder}/${randomUUID()}.${format}`;
  const contentType = `image/${format}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
      Body: processed,
      ContentType: contentType,
    })
  );

  return {
    key,
    publicUrl: `${process.env.S3_PUBLIC_URL}/${key}`,
    size: processed.length,
  };
}

// Thumbnail generation
export async function generateThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(200, 200, { fit: 'cover' })
    .toFormat('webp', { quality: 70 })
    .toBuffer();
}

// Avatar upload route using multer memory + sharp
// src/routes/profile.ts
import { Router } from 'express';
import { memoryUpload } from '../lib/multer';
import { resizeAndUpload } from '../lib/image';
import { asyncHandler } from '../lib/route-helpers';
import { requireAuth } from '../middleware/auth';

export const profileRouter = Router();

profileRouter.post(
  '/avatar',
  requireAuth,
  memoryUpload.single('avatar'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = await resizeAndUpload(req.file.buffer, 'avatars', {
      width: 400,
      height: 400,
      fit: 'cover',
      format: 'webp',
      quality: 85,
    });

    // Save result.publicUrl to user profile in DB here
    await db.update(profiles)
      .set({ avatarUrl: result.publicUrl })
      .where(eq(profiles.userId, req.user.sub));

    res.json({ data: { avatarUrl: result.publicUrl } });
  })
);
```

---

### 5. React Drag-and-Drop File Upload Component

```tsx
// src/components/FileUploader.tsx
'use client';

import { useState, useCallback } from 'react';
import { useDropzone, FileRejection } from 'react-dropzone';

interface UploadedFile {
  key: string;
  publicUrl: string;
  name: string;
  size: number;
}

interface FileUploaderProps {
  onUploadComplete?: (file: UploadedFile) => void;
  accept?: Record<string, string[]>;
  maxSizeMB?: number;
  folder?: string;
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export function FileUploader({
  onUploadComplete,
  accept = { 'image/*': ['.jpg', '.jpeg', '.png', '.webp'] },
  maxSizeMB = 10,
  folder = 'attachments',
}: FileUploaderProps) {
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);

  const uploadFile = async (file: File) => {
    setStatus('uploading');
    setProgress(0);
    setError(null);

    try {
      // Step 1: Get presigned URL from our API
      const presignRes = await fetch('/api/v1/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: file.type,
          contentLength: file.size,
          filename: file.name,
          folder,
        }),
      });

      if (!presignRes.ok) {
        const err = await presignRes.json();
        throw new Error(err.error ?? 'Failed to get upload URL');
      }

      const { data } = await presignRes.json();
      const { uploadUrl, key, publicUrl } = data;

      // Step 2: Upload directly to S3 with progress tracking
      await uploadWithProgress(uploadUrl, file, setProgress);

      const uploaded: UploadedFile = {
        key,
        publicUrl,
        name: file.name,
        size: file.size,
      };

      setUploadedFile(uploaded);
      setStatus('success');
      onUploadComplete?.(uploaded);
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const onDrop = useCallback(
    (acceptedFiles: File[], rejections: FileRejection[]) => {
      if (rejections.length > 0) {
        const messages = rejections.flatMap((r) => r.errors.map((e) => e.message));
        setError(messages[0]);
        setStatus('error');
        return;
      }
      if (acceptedFiles[0]) uploadFile(acceptedFiles[0]);
    },
    [folder]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxSize: maxSizeMB * 1024 * 1024,
    maxFiles: 1,
    disabled: status === 'uploading',
  });

  return (
    <div className="w-full">
      <div
        {...getRootProps()}
        className={[
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400',
          status === 'uploading' ? 'opacity-50 cursor-not-allowed' : '',
        ].join(' ')}
      >
        <input {...getInputProps()} />

        {status === 'uploading' ? (
          <div>
            <p className="text-sm text-gray-600 mb-2">Uploading... {progress}%</p>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : status === 'success' && uploadedFile ? (
          <div>
            <p className="text-sm text-green-600 font-medium">Upload complete</p>
            <p className="text-xs text-gray-500 mt-1">{uploadedFile.name}</p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-600">
              {isDragActive ? 'Drop file here' : 'Drag & drop or click to select'}
            </p>
            <p className="text-xs text-gray-400 mt-1">Max {maxSizeMB}MB</p>
          </div>
        )}
      </div>

      {status === 'error' && error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}

// XMLHttpRequest-based upload for progress tracking (fetch does not support upload progress)
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`S3 upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}
```

---

### 6. Multi-File Upload with Preview

```tsx
// src/components/MultiFileUploader.tsx
'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

interface FileWithPreview extends File {
  preview: string;
}

interface UploadState {
  file: FileWithPreview;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
  url?: string;
}

export function MultiFileUploader({ maxFiles = 5 }: { maxFiles?: number }) {
  const [uploads, setUploads] = useState<UploadState[]>([]);

  const updateUpload = (index: number, patch: Partial<UploadState>) => {
    setUploads((prev) => prev.map((u, i) => (i === index ? { ...u, ...patch } : u)));
  };

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newUploads: UploadState[] = acceptedFiles.map((file) => ({
        file: Object.assign(file, { preview: URL.createObjectURL(file) }),
        progress: 0,
        status: 'pending',
      }));

      setUploads((prev) => [...prev, ...newUploads].slice(0, maxFiles));

      // Start uploading each
      newUploads.forEach((upload, i) => {
        const index = uploads.length + i;
        uploadSingle(upload.file, index);
      });
    },
    [uploads.length, maxFiles]
  );

  const uploadSingle = async (file: FileWithPreview, index: number) => {
    updateUpload(index, { status: 'uploading' });

    try {
      const res = await fetch('/api/v1/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
      });
      const { data } = await res.json();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', data.uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            updateUpload(index, { progress: Math.round((e.loaded / e.total) * 100) });
          }
        };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error('S3 error')));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(file);
      });

      updateUpload(index, { status: 'done', url: data.publicUrl, progress: 100 });
    } catch (err: unknown) {
      updateUpload(index, {
        status: 'error',
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    maxFiles,
  });

  return (
    <div>
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded p-6 text-center cursor-pointer ${
          isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
        }`}
      >
        <input {...getInputProps()} />
        <p className="text-sm text-gray-500">Drop up to {maxFiles} images here</p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {uploads.map((u, i) => (
          <div key={i} className="relative rounded overflow-hidden border">
            <img
              src={u.file.preview}
              alt=""
              className="w-full h-24 object-cover"
              onLoad={() => URL.revokeObjectURL(u.file.preview)}
            />
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              {u.status === 'uploading' && (
                <span className="text-white text-xs font-bold">{u.progress}%</span>
              )}
              {u.status === 'done' && (
                <span className="text-green-400 text-lg">&#10003;</span>
              )}
              {u.status === 'error' && (
                <span className="text-red-400 text-xs">{u.error}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### 7. File Type and Size Validation Utilities

```typescript
// src/lib/file-validation.ts
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOCUMENT_TYPES = new Set(['application/pdf', 'text/plain', 'text/csv']);
const ALL_ALLOWED = new Set([...IMAGE_TYPES, ...DOCUMENT_TYPES]);

export function validateFileType(
  mimetype: string,
  allowedTypes: Set<string> = ALL_ALLOWED
): void {
  if (!allowedTypes.has(mimetype)) {
    throw new Error(`File type "${mimetype}" is not allowed`);
  }
}

export function validateFileSize(bytes: number, maxMB: number = 10): void {
  const maxBytes = maxMB * 1024 * 1024;
  if (bytes > maxBytes) {
    throw new Error(`File size ${(bytes / 1024 / 1024).toFixed(1)}MB exceeds limit of ${maxMB}MB`);
  }
}

export function sanitizeFilename(name: string): string {
  // Remove directory traversal chars and limit length
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 200);
}

export function getExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
  };
  return map[mimetype] ?? '.bin';
}
```

---

## Common Mistakes

- **Trusting the client-supplied `Content-Type`**: Always re-validate the file's actual magic bytes server-side using `file-type` npm package rather than trusting `req.file.mimetype` from multer, which comes from the HTTP header and can be spoofed.

  ```typescript
  import { fileTypeFromBuffer } from 'file-type';
  const type = await fileTypeFromBuffer(req.file.buffer);
  if (!type || !ALLOWED_TYPES.has(type.mime)) throw new Error('Invalid file');
  ```

- **Using `fetch` for S3 upload progress**: The Fetch API does not expose upload progress events. Use `XMLHttpRequest` with `xhr.upload.onprogress` for client-side progress tracking.

- **Storing S3 keys instead of full URLs**: Storing the full public URL in the DB ties you to a specific domain. Store the `key` and derive the URL at query time so you can change the CDN/domain without a DB migration.

- **Not revoking object URLs**: Calling `URL.createObjectURL()` for file previews leaks memory if you don't call `URL.revokeObjectURL()` when the component unmounts or the image loads.

- **Uploading on the server instead of directly to S3**: Piping the upload through your server doubles bandwidth usage and ties up Node.js threads. Use presigned URLs to upload directly from the client to S3.

- **Not setting `ContentLength` in the presigned `PutObjectCommand`**: Without `ContentLength`, S3 does not enforce the size limit in the presigned URL, allowing oversized uploads.

---

## Framework-Specific Notes

### Next.js

- Route Handlers default to a 4MB body size limit. For direct server-side file handling, increase via `export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }` (Pages Router) or use `next.config.js` `experimental.serverActions.bodySizeLimit` (App Router).
- Prefer the presigned URL pattern — the client uploads directly to S3, and the Next.js route handler only generates the URL. This keeps the Next.js server stateless.
- For image optimization, use `next/image` with the `publicUrl` from S3 as the `src`.

### Express

- Multer must be added as a per-route middleware (not globally). Applying it globally means every request body is processed as multipart even when it is not.
- Use `memoryUpload` in production so you can pipe the buffer to Sharp/S3 without writing temp files. Use `diskStorage` only in development or for very large files.
- Serve local uploads with `express.static('./uploads')` in development only. Never serve user-uploaded files without going through a CDN or content security checks in production.
