# AI Integration

## When to Use This

- Ticket mentions: AI, OpenAI, Claude, GPT, LLM, chatbot, image generation, streaming, embeddings, vector search, function calling, tool use, assistants

---

## Quick Start

### Dependencies

```bash
# OpenAI
npm install openai

# Anthropic / Claude
npm install @anthropic-ai/sdk

# Token counting (OpenAI-compatible)
npm install js-tiktoken

# Optional: Vercel AI SDK (unified streaming, Next.js integration)
npm install ai
```

### Environment Variables

```bash
# .env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Never expose these to the client. Server-side only.
```

```typescript
// lib/env.ts — validate at startup
import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);
```

---

## Patterns

### 1. OpenAI Chat Completions (Basic)

```typescript
// lib/openai.ts
import OpenAI from "openai";

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // maxRetries: 3, // default is 2
  // timeout: 30_000, // ms
});
```

```typescript
// services/ai.ts
import { openai } from "@/lib/openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

interface ChatOptions {
  messages: ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export async function chat(options: ChatOptions): Promise<string> {
  const {
    messages,
    model = "gpt-4o",
    temperature = 0.7,
    maxTokens = 1024,
    systemPrompt,
  } = options;

  const allMessages: ChatCompletionMessageParam[] = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    ...messages,
  ];

  const response = await openai.chat.completions.create({
    model,
    messages: allMessages,
    temperature,
    max_tokens: maxTokens,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("No content in AI response");
  return content;
}

// Usage
const reply = await chat({
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Explain closures in JavaScript." }],
  temperature: 0.3,
  maxTokens: 512,
});
```

---

### 2. Streaming Responses

**Server-side stream (Express / Node.js)**

```typescript
// routes/chat.ts
import { Router } from "express";
import { openai } from "@/lib/openai";

const router = Router();

router.post("/chat/stream", async (req, res) => {
  const { messages, systemPrompt } = req.body as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    systemPrompt?: string;
  };

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...messages,
      ],
      max_tokens: 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        // SSE format: "data: <payload>\n\n"
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`);
    res.end();
  }
});

export default router;
```

**Client-side consumption (React)**

```typescript
// hooks/useStream.ts
import { useState, useCallback } from "react";

export function useStream() {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stream = useCallback(
    async (messages: Array<{ role: "user" | "assistant"; content: string }>) => {
      setIsStreaming(true);
      setText("");
      setError(null);

      try {
        const response = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") break;

            try {
              const { delta, error: streamError } = JSON.parse(payload);
              if (streamError) throw new Error(streamError);
              if (delta) setText((prev) => prev + delta);
            } catch {
              // Ignore malformed chunks
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setIsStreaming(false);
      }
    },
    []
  );

  return { text, isStreaming, error, stream };
}
```

---

### 3. Claude / Anthropic API Integration

```typescript
// lib/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

```typescript
// services/claude.ts
import { anthropic } from "@/lib/anthropic";

interface ClaudeOptions {
  userMessage: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function claudeChat(options: ClaudeOptions): Promise<string> {
  const {
    userMessage,
    systemPrompt = "You are a helpful assistant.",
    model = "claude-opus-4-6",
    maxTokens = 1024,
    temperature = 1, // Claude's default; range 0–1
  } = options;

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    // temperature, // Only pass if overriding default
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

// Streaming variant
export async function claudeChatStream(
  options: ClaudeOptions,
  onDelta: (text: string) => void
): Promise<void> {
  const { userMessage, systemPrompt = "You are a helpful assistant.", model = "claude-opus-4-6", maxTokens = 2048 } =
    options;

  const stream = await anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      onDelta(event.delta.text);
    }
  }
}
```

---

### 4. Image Generation (DALL-E)

```typescript
// services/image-generation.ts
import { openai } from "@/lib/openai";
import type { ImageGenerateParams } from "openai/resources/images";

interface GenerateImageOptions {
  prompt: string;
  size?: ImageGenerateParams["size"];
  quality?: ImageGenerateParams["quality"];
  style?: ImageGenerateParams["style"];
  n?: number;
}

interface GeneratedImage {
  url: string;
  revisedPrompt?: string;
}

export async function generateImage(
  options: GenerateImageOptions
): Promise<GeneratedImage[]> {
  const {
    prompt,
    size = "1024x1024",
    quality = "standard",
    style = "vivid",
    n = 1,
  } = options;

  // Sanitize prompt — remove instructions that could be injected
  const sanitized = prompt.slice(0, 4000).replace(/[<>]/g, "");

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: sanitized,
    size,
    quality,
    style,
    n,
    response_format: "url",
  });

  return response.data.map((img) => ({
    url: img.url ?? "",
    revisedPrompt: img.revised_prompt,
  }));
}

// Route handler with proper error handling
// routes/images.ts
import { Router } from "express";
import { generateImage } from "@/services/image-generation";

const router = Router();

router.post("/images/generate", async (req, res) => {
  const { prompt, size } = req.body as { prompt: string; size?: string };

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }

  try {
    const images = await generateImage({ prompt, size: size as GenerateImageOptions["size"] });
    res.json({ images });
  } catch (err: unknown) {
    // OpenAI content policy rejection
    if (
      err instanceof Error &&
      "status" in err &&
      (err as { status: number }).status === 400
    ) {
      return res.status(400).json({ error: "Prompt rejected by content policy" });
    }
    console.error("Image generation error:", err);
    res.status(500).json({ error: "Image generation failed" });
  }
});

export default router;
```

---

### 5. Embeddings and Vector Similarity Search

```typescript
// services/embeddings.ts
import { openai } from "@/lib/openai";

export async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small", // 1536 dims; use "text-embedding-3-large" for higher quality
    input: text.slice(0, 8191), // Model token limit
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts.map((t) => t.slice(0, 8191)),
  });
  return response.data.map((d) => d.embedding);
}

// Cosine similarity (pure JS, no external dependency)
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Simple in-memory vector store (swap for pgvector / Pinecone in production)
interface VectorRecord {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export class InMemoryVectorStore {
  private records: VectorRecord[] = [];

  async add(id: string, text: string, metadata?: Record<string, unknown>) {
    const embedding = await embed(text);
    this.records.push({ id, text, embedding, metadata });
  }

  async search(query: string, topK = 5): Promise<Array<VectorRecord & { score: number }>> {
    const queryEmbedding = await embed(query);
    return this.records
      .map((r) => ({ ...r, score: cosineSimilarity(queryEmbedding, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
```

**pgvector integration (Drizzle ORM)**

```typescript
// If using PostgreSQL + pgvector extension:
// CREATE EXTENSION IF NOT EXISTS vector;

// db/schema/documents.ts
import { pgTable, text, uuid, customType } from "drizzle-orm/pg-core";

// Custom pgvector type for Drizzle
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[] }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value) {
      return `[${value.join(",")}]`;
    },
    fromDriver(value) {
      return (value as string)
        .slice(1, -1)
        .split(",")
        .map(Number);
    },
  })(name);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  embedding: vector("embedding", 1536),
});

// Cosine similarity search via raw SQL
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function semanticSearch(queryEmbedding: number[], topK = 5) {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  return db.execute(
    sql`SELECT id, content, 1 - (embedding <=> ${embeddingStr}::vector) AS score
        FROM documents
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${topK}`
  );
}
```

---

### 6. Chat Interface with Message History

```typescript
// types/chat.ts
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export type ConversationHistory = Message[];
```

```typescript
// services/conversation.ts
import { openai } from "@/lib/openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Message } from "@/types/chat";

const MAX_HISTORY_MESSAGES = 20; // Prevent unbounded context growth

export async function continueConversation(
  history: Message[],
  userMessage: string,
  systemPrompt: string
): Promise<string> {
  // Trim history to last N messages (keep system prompt separate)
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);

  const apiMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...trimmed.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: apiMessages,
    max_tokens: 1024,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content ?? "";
}
```

```tsx
// components/ChatInterface.tsx
"use client";
import { useState, useRef, useEffect } from "react";
import type { Message } from "@/types/chat";

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const sendMessage = async () => {
    const userContent = input.trim();
    if (!userContent || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userContent,
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setStreamingText("");

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;

          try {
            const { delta } = JSON.parse(payload);
            if (delta) {
              accumulated += delta;
              setStreamingText(accumulated);
            }
          } catch {
            // skip
          }
        }
      }

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: accumulated,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamingText("");
    } catch (err) {
      console.error("Chat error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] rounded-lg px-4 py-2 whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[75%] rounded-lg px-4 py-2 bg-gray-100 text-gray-900 whitespace-pre-wrap">
              {streamingText}
              <span className="inline-block w-1 h-4 ml-0.5 bg-gray-400 animate-pulse" />
            </div>
          </div>
        )}
        {isLoading && !streamingText && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg px-4 py-2 text-gray-500">
              Thinking...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t p-4 flex gap-2">
        <input
          className="flex-1 border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

---

### 7. Function Calling / Tool Use

```typescript
// services/tools.ts
import { openai } from "@/lib/openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

// Define tools
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City and state/country, e.g. 'San Francisco, CA'",
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Temperature unit",
          },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_database",
      description: "Search the product database for items matching a query",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          category: { type: "string", description: "Optional category filter" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
];

// Tool implementations (server-side only)
async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "get_weather": {
      // Replace with real weather API call
      const { location, unit = "fahrenheit" } = args as { location: string; unit?: string };
      return JSON.stringify({ location, temperature: 72, unit, condition: "Sunny" });
    }
    case "search_database": {
      const { query, category, limit = 10 } = args as {
        query: string;
        category?: string;
        limit?: number;
      };
      // Replace with real DB query
      return JSON.stringify({ results: [], query, category, limit });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Agentic loop — runs until model stops calling tools
export async function runWithTools(userMessage: string): Promise<string> {
  const messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }> = [
    { role: "system", content: "You are a helpful assistant with access to tools." },
    { role: "user", content: userMessage },
  ];

  for (let iteration = 0; iteration < 10; iteration++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1024,
    });

    const choice = response.choices[0];
    const assistantMessage = choice.message;

    messages.push({
      role: "assistant",
      content: assistantMessage.content ?? "",
      tool_calls: assistantMessage.tool_calls,
    });

    // No tool calls — we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content ?? "";
    }

    // Execute each tool call and append results
    for (const toolCall of assistantMessage.tool_calls) {
      let result: string;
      try {
        const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        result = await executeTool(toolCall.function.name, args);
      } catch (err) {
        result = JSON.stringify({ error: err instanceof Error ? err.message : "Tool execution failed" });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  throw new Error("Tool loop exceeded max iterations");
}
```

**Claude tool use equivalent**

```typescript
// services/claude-tools.ts
import { anthropic } from "@/lib/anthropic";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

const claudeTools: Tool[] = [
  {
    name: "get_weather",
    description: "Get current weather for a location",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, e.g. 'Paris'" },
      },
      required: ["location"],
    },
  },
];

export async function claudeRunWithTools(userMessage: string): Promise<string> {
  const messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      tools: claudeTools,
      messages,
    });

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && "text" in textBlock ? textBlock.text : "";
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let result: string;
        try {
          result = await executeTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = JSON.stringify({ error: String(err) });
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  throw new Error("Tool loop exceeded max iterations");
}
```

---

### 8. Rate Limiting and Error Handling

```typescript
// lib/ai-retry.ts
import type OpenAI from "openai";
import { APIError } from "openai";

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof APIError && err.status === 429;
}

function isServerError(err: unknown): boolean {
  return err instanceof APIError && (err.status ?? 0) >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const isRetryable = isRateLimitError(err) || isServerError(err);
      if (!isRetryable || attempt === maxAttempts) throw err;

      // Exponential backoff with jitter
      const delay = initialDelayMs * 2 ** (attempt - 1) + Math.random() * 200;

      // Honor Retry-After header if present
      if (err instanceof APIError && err.headers?.["retry-after"]) {
        const retryAfter = parseInt(err.headers["retry-after"] as string, 10);
        if (!isNaN(retryAfter)) {
          await sleep(retryAfter * 1000);
          continue;
        }
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

// Usage
const result = await withRetry(() =>
  openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
  })
);
```

```typescript
// lib/ai-errors.ts — Centralized error handling
import { APIError } from "openai";

export function classifyAIError(err: unknown): {
  type: "rate_limit" | "context_length" | "content_policy" | "auth" | "server" | "unknown";
  message: string;
  retryable: boolean;
} {
  if (!(err instanceof APIError)) {
    return { type: "unknown", message: String(err), retryable: false };
  }

  switch (err.status) {
    case 401:
    case 403:
      return { type: "auth", message: "Invalid or missing API key", retryable: false };
    case 429:
      return { type: "rate_limit", message: "Rate limit exceeded, please slow down", retryable: true };
    case 400:
      if (err.message.includes("context_length_exceeded")) {
        return { type: "context_length", message: "Prompt is too long", retryable: false };
      }
      if (err.message.includes("content_policy")) {
        return { type: "content_policy", message: "Content rejected by policy", retryable: false };
      }
      return { type: "unknown", message: err.message, retryable: false };
    default:
      if (err.status && err.status >= 500) {
        return { type: "server", message: "AI provider error, please try again", retryable: true };
      }
      return { type: "unknown", message: err.message, retryable: false };
  }
}
```

**Per-user rate limiting (server-side)**

```typescript
// middleware/ai-rate-limit.ts
import type { Request, Response, NextFunction } from "express";

interface RateLimitState {
  count: number;
  resetAt: number;
}

const limits = new Map<string, RateLimitState>();

const MAX_REQUESTS_PER_MINUTE = 20;

export function aiRateLimit(req: Request, res: Response, next: NextFunction) {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? req.ip;
  if (!userId) return next();

  const now = Date.now();
  const state = limits.get(userId);

  if (!state || now > state.resetAt) {
    limits.set(userId, { count: 1, resetAt: now + 60_000 });
    return next();
  }

  if (state.count >= MAX_REQUESTS_PER_MINUTE) {
    const retryAfter = Math.ceil((state.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "Too many AI requests. Please wait before trying again.",
      retryAfter,
    });
  }

  state.count++;
  next();
}
```

---

### 9. Token Counting and Cost Estimation

```typescript
// lib/tokens.ts
import { encodingForModel } from "js-tiktoken";
import type { TiktokenModel } from "js-tiktoken";

// Prices per 1M tokens (USD) — update as OpenAI changes pricing
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export function countTokens(text: string, model: TiktokenModel = "gpt-4o"): number {
  try {
    const enc = encodingForModel(model);
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch {
    // Fallback: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}

export function countMessageTokens(
  messages: Array<{ role: string; content: string }>,
  model: TiktokenModel = "gpt-4o"
): number {
  // ~3 tokens overhead per message (role, separators)
  const overhead = messages.length * 3 + 3;
  const contentTokens = messages.reduce(
    (sum, m) => sum + countTokens(m.content, model),
    0
  );
  return contentTokens + overhead;
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string
): { inputCost: number; outputCost: number; totalCost: number } {
  const pricing = PRICING[model] ?? { input: 0, output: 0 };
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

// Usage tracking middleware for Express
export function logTokenUsage(
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number }
) {
  const { totalCost } = estimateCost(usage.prompt_tokens, usage.completion_tokens, model);
  console.info({
    model,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    estimatedCostUsd: totalCost.toFixed(6),
  });
}
```

---

## Common Mistakes

**Not streaming responses**
Long completions (>2s) block the UI. Always stream for user-facing text generation. Use `stream: true` in OpenAI or `anthropic.messages.stream()` for Claude. Even a simple typewriter effect dramatically improves perceived performance.

**Exposing API keys to the client**
Never pass `OPENAI_API_KEY` to browser bundles. All AI calls must go through your server. In Next.js, only call OpenAI from Route Handlers or Server Actions — never from `"use client"` components.

```typescript
// WRONG — key exposed in client bundle
const openai = new OpenAI({ apiKey: process.env.NEXT_PUBLIC_OPENAI_KEY, dangerouslyAllowBrowser: true });

// CORRECT — server-side only
// app/api/chat/route.ts (Next.js Route Handler — runs on server)
import { openai } from "@/lib/openai";
```

**Not handling rate limits**
OpenAI returns HTTP 429 when limits are exceeded. Wrap all API calls in retry logic with exponential backoff (see pattern 8). Never show raw API errors to users.

**Unbounded token usage**
Always set `max_tokens`. Without it, a prompt can generate thousands of tokens and cost dollars per request. Set a hard ceiling appropriate to your use case (e.g., `512` for summaries, `2048` for code generation).

**Not sanitizing user input**
User text goes directly into prompts. Validate length, strip dangerous patterns, and use system prompt framing to limit model behavior:

```typescript
function sanitizeInput(input: string, maxLength = 2000): string {
  return input
    .trim()
    .slice(0, maxLength)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""); // strip control chars
}
```

**Not trimming conversation history**
Each request re-sends the full history. Trim to the last 10–20 messages and summarize older context to keep costs under control.

---

## Framework-Specific Notes

### Next.js (Route Handlers + Vercel AI SDK)

```typescript
// app/api/chat/route.ts — streaming with Vercel AI SDK
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export const maxDuration = 30; // Vercel function timeout

export async function POST(req: Request) {
  const { messages } = await req.json() as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };

  const result = await streamText({
    model: openai("gpt-4o"),
    system: "You are a helpful assistant.",
    messages,
    maxTokens: 1024,
  });

  return result.toDataStreamResponse();
}
```

```tsx
// app/chat/page.tsx — client consumption with useChat hook
"use client";
import { useChat } from "ai/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: "/api/chat",
  });

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}>
            <span className="inline-block bg-gray-100 rounded px-3 py-1">{m.content}</span>
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          value={input}
          onChange={handleInputChange}
          placeholder="Ask something..."
        />
        <button type="submit" disabled={isLoading} className="px-4 py-2 bg-blue-600 text-white rounded">
          Send
        </button>
      </form>
    </div>
  );
}
```

```bash
# Additional Vercel AI SDK dependencies
npm install ai @ai-sdk/openai @ai-sdk/anthropic
```

### Express

```typescript
// Full Express AI endpoint setup
import express from "express";
import { openai } from "@/lib/openai";
import { aiRateLimit } from "@/middleware/ai-rate-limit";
import { withRetry } from "@/lib/ai-retry";

const app = express();
app.use(express.json({ limit: "1mb" })); // Limit request body size

// Apply rate limiting to all AI routes
app.use("/api/ai", aiRateLimit);

app.post("/api/ai/complete", async (req, res) => {
  const { prompt, maxTokens = 512 } = req.body as {
    prompt: string;
    maxTokens?: number;
  };

  if (!prompt || typeof prompt !== "string" || prompt.length > 10_000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  try {
    const response = await withRetry(() =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: Math.min(maxTokens, 2048), // Hard cap
      })
    );

    res.json({
      content: response.choices[0]?.message?.content ?? "",
      usage: response.usage,
    });
  } catch (err) {
    const { type, message } = classifyAIError(err);
    const status = type === "rate_limit" ? 429 : type === "auth" ? 401 : 500;
    res.status(status).json({ error: message });
  }
});
```

### React (Streaming Display)

```tsx
// components/StreamingText.tsx — Progressive rendering with cursor
"use client";
import { useEffect, useRef } from "react";

interface StreamingTextProps {
  text: string;
  isStreaming: boolean;
  className?: string;
}

export function StreamingText({ text, isStreaming, className }: StreamingTextProps) {
  return (
    <span className={className}>
      {text}
      {isStreaming && (
        <span
          className="inline-block w-0.5 h-4 ml-0.5 bg-current align-middle animate-pulse"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

// components/MarkdownStream.tsx — Streaming markdown rendering
// npm install react-markdown
import ReactMarkdown from "react-markdown";

export function MarkdownStream({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isStreaming && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [text, isStreaming]);

  return (
    <div ref={ref} className="prose prose-sm max-w-none">
      <ReactMarkdown>{text}</ReactMarkdown>
      {isStreaming && <span className="inline-block w-0.5 h-4 bg-gray-400 animate-pulse" />}
    </div>
  );
}
```
