# Realtime Communication

## When to Use This

Use these patterns when you need live updates between server and clients — chat messages, typing indicators, presence tracking, live notifications, or streaming data. Covers raw WebSockets (`ws`), Socket.io, and Server-Sent Events (SSE).

## Quick Start

### Dependencies

```bash
# Raw WebSocket server (lightweight, no frills)
npm install ws
npm install -D @types/ws

# Socket.io (higher-level, rooms, namespaces, reconnect, fallbacks)
npm install socket.io socket.io-client

# SSE (no extra dependencies — built on HTTP)
# For Next.js SSE, use ReadableStream or EventEmitter

# Redis adapter for multi-server Socket.io
npm install @socket.io/redis-adapter ioredis
```

### Environment Variables

```env
REDIS_URL=redis://localhost:6379
WS_PORT=3001
JWT_SECRET=your_jwt_secret
```

---

## Patterns

### 1. WebSocket Server with `ws` — Authenticated, Typed Messages

```typescript
// src/lib/websocket/server.ts
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import jwt from 'jsonwebtoken';

// Message type discriminated union
export type ServerMessage =
  | { type: 'chat'; roomId: string; content: string; userId: string; username: string; ts: number }
  | { type: 'typing'; roomId: string; userId: string; username: string; isTyping: boolean }
  | { type: 'presence'; roomId: string; users: string[]; event: 'join' | 'leave' }
  | { type: 'error'; message: string }
  | { type: 'ack'; messageId: string };

export type ClientMessage =
  | { type: 'join'; roomId: string }
  | { type: 'leave'; roomId: string }
  | { type: 'chat'; roomId: string; content: string; messageId: string }
  | { type: 'typing'; roomId: string; isTyping: boolean }
  | { type: 'ping' };

interface AuthenticatedSocket extends WebSocket {
  userId: string;
  username: string;
  rooms: Set<string>;
  isAlive: boolean;
}

// roomId -> Set of connected sockets
const rooms = new Map<string, Set<AuthenticatedSocket>>();

function broadcast(roomId: string, message: ServerMessage, exclude?: AuthenticatedSocket) {
  const members = rooms.get(roomId);
  if (!members) return;
  const payload = JSON.stringify(message);
  for (const client of members) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function send(ws: AuthenticatedSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function authenticate(req: IncomingMessage): { userId: string; username: string } | null {
  try {
    const { query } = parse(req.url ?? '', true);
    const token = query.token as string;
    if (!token) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    return { userId: payload.sub, username: payload.username ?? payload.email };
  } catch {
    return null;
  }
}

export function createWsServer(port: number) {
  const wss = new WebSocketServer({ port });

  // Heartbeat: detect dead connections every 30s
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AuthenticatedSocket;
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  wss.on('connection', (rawWs: WebSocket, req: IncomingMessage) => {
    const auth = authenticate(req);
    if (!auth) {
      rawWs.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      rawWs.close(1008, 'Unauthorized');
      return;
    }

    const ws = rawWs as AuthenticatedSocket;
    ws.userId = auth.userId;
    ws.username = auth.username;
    ws.rooms = new Set();
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        case 'join': {
          if (!rooms.has(msg.roomId)) rooms.set(msg.roomId, new Set());
          rooms.get(msg.roomId)!.add(ws);
          ws.rooms.add(msg.roomId);
          const users = [...rooms.get(msg.roomId)!].map((s) => s.username);
          broadcast(msg.roomId, { type: 'presence', roomId: msg.roomId, users, event: 'join' });
          break;
        }
        case 'leave': {
          leaveRoom(ws, msg.roomId);
          break;
        }
        case 'chat': {
          if (!ws.rooms.has(msg.roomId)) {
            send(ws, { type: 'error', message: 'Not in room' });
            return;
          }
          const chatMsg: ServerMessage = {
            type: 'chat',
            roomId: msg.roomId,
            content: msg.content.slice(0, 4000), // limit length
            userId: ws.userId,
            username: ws.username,
            ts: Date.now(),
          };
          broadcast(msg.roomId, chatMsg);
          send(ws, { type: 'ack', messageId: msg.messageId });
          break;
        }
        case 'typing': {
          broadcast(msg.roomId, {
            type: 'typing',
            roomId: msg.roomId,
            userId: ws.userId,
            username: ws.username,
            isTyping: msg.isTyping,
          }, ws);
          break;
        }
        case 'ping': {
          ws.send(JSON.stringify({ type: 'ack', messageId: 'pong' }));
          break;
        }
      }
    });

    ws.on('close', () => {
      for (const roomId of ws.rooms) leaveRoom(ws, roomId);
    });
  });

  function leaveRoom(ws: AuthenticatedSocket, roomId: string) {
    rooms.get(roomId)?.delete(ws);
    ws.rooms.delete(roomId);
    if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
    const users = [...(rooms.get(roomId) ?? [])].map((s) => s.username);
    broadcast(roomId, { type: 'presence', roomId, users, event: 'leave' });
  }

  console.log(`WebSocket server running on ws://localhost:${port}`);
  return wss;
}
```

---

### 2. Socket.io Server — Rooms, Namespaces, Redis Adapter

```typescript
// src/lib/socketio/server.ts
import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';

export interface SocketData {
  userId: string;
  username: string;
}

// Extend Socket type with our data
type AuthSocket = Socket<ClientEvents, ServerEvents, {}, SocketData>;

interface ServerEvents {
  'chat:message': (payload: {
    roomId: string;
    content: string;
    userId: string;
    username: string;
    ts: number;
  }) => void;
  'chat:typing': (payload: { roomId: string; userId: string; isTyping: boolean }) => void;
  'room:presence': (payload: { roomId: string; users: string[] }) => void;
  error: (payload: { message: string }) => void;
}

interface ClientEvents {
  'room:join': (roomId: string) => void;
  'room:leave': (roomId: string) => void;
  'chat:send': (payload: { roomId: string; content: string }) => void;
  'chat:typing': (payload: { roomId: string; isTyping: boolean }) => void;
}

export async function createSocketServer(httpServer: HttpServer) {
  // Redis pub/sub for horizontal scaling
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);

  const io = new Server<ClientEvents, ServerEvents, {}, SocketData>(httpServer, {
    cors: {
      origin: (process.env.CORS_ORIGINS ?? '').split(','),
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  // JWT auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
      socket.data.userId = payload.sub;
      socket.data.username = payload.username ?? payload.email;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthSocket) => {
    const { userId, username } = socket.data;

    socket.on('room:join', async (roomId: string) => {
      await socket.join(roomId);
      const socketsInRoom = await io.in(roomId).fetchSockets();
      const users = socketsInRoom.map((s) => s.data.username).filter(Boolean);
      io.to(roomId).emit('room:presence', { roomId, users });
    });

    socket.on('room:leave', async (roomId: string) => {
      await socket.leave(roomId);
      const socketsInRoom = await io.in(roomId).fetchSockets();
      const users = socketsInRoom.map((s) => s.data.username).filter(Boolean);
      io.to(roomId).emit('room:presence', { roomId, users });
    });

    socket.on('chat:send', ({ roomId, content }) => {
      if (!socket.rooms.has(roomId)) {
        socket.emit('error', { message: 'Not in room' });
        return;
      }
      io.to(roomId).emit('chat:message', {
        roomId,
        content: content.slice(0, 4000),
        userId,
        username,
        ts: Date.now(),
      });
    });

    socket.on('chat:typing', ({ roomId, isTyping }) => {
      socket.to(roomId).emit('chat:typing', { roomId, userId, isTyping });
    });

    socket.on('disconnecting', () => {
      // socket.rooms contains all rooms the socket is in
    });
  });

  return io;
}
```

---

### 3. Socket.io Client Hook (React)

```tsx
// src/hooks/useSocket.ts
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

interface UseSocketOptions {
  url: string;
  token: string | null;
  enabled?: boolean;
}

export function useSocket({ url, token, enabled = true }: UseSocketOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !token) return;

    const socket = io(url, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => console.error('Socket error:', err.message));

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [url, token, enabled]);

  const emit = useCallback(<T>(event: string, data: T) => {
    socketRef.current?.emit(event, data);
  }, []);

  const on = useCallback(<T>(event: string, handler: (data: T) => void) => {
    socketRef.current?.on(event, handler);
    return () => socketRef.current?.off(event, handler);
  }, []);

  return { socket: socketRef.current, connected, emit, on };
}
```

```tsx
// src/hooks/useChat.ts
'use client';

import { useEffect, useState, useRef } from 'react';
import { useSocket } from './useSocket';

interface ChatMessage {
  roomId: string;
  content: string;
  userId: string;
  username: string;
  ts: number;
}

interface TypingState {
  [userId: string]: { username: string; isTyping: boolean };
}

export function useChat(roomId: string, token: string | null) {
  const { socket, connected, emit } = useSocket({
    url: process.env.NEXT_PUBLIC_SOCKET_URL!,
    token,
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState<TypingState>({});
  const [presenceUsers, setPresenceUsers] = useState<string[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!socket || !connected) return;

    socket.emit('room:join', roomId);

    const onMessage = (msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    };

    const onTyping = (data: { roomId: string; userId: string; username: string; isTyping: boolean }) => {
      setTyping((prev) => ({
        ...prev,
        [data.userId]: { username: data.username, isTyping: data.isTyping },
      }));
    };

    const onPresence = (data: { roomId: string; users: string[] }) => {
      setPresenceUsers(data.users);
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:typing', onTyping);
    socket.on('room:presence', onPresence);

    return () => {
      socket.emit('room:leave', roomId);
      socket.off('chat:message', onMessage);
      socket.off('chat:typing', onTyping);
      socket.off('room:presence', onPresence);
    };
  }, [socket, connected, roomId]);

  const sendMessage = (content: string) => {
    emit('chat:send', { roomId, content });
    // Optimistic update
    setMessages((prev) => [
      ...prev,
      { roomId, content, userId: 'me', username: 'You', ts: Date.now() },
    ]);
  };

  const setTypingStatus = (isTyping: boolean) => {
    emit('chat:typing', { roomId, isTyping });
    // Auto clear typing after 3s of inactivity
    if (isTyping) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        emit('chat:typing', { roomId, isTyping: false });
      }, 3000);
    }
  };

  const typingUsers = Object.values(typing)
    .filter((t) => t.isTyping)
    .map((t) => t.username);

  return { messages, typingUsers, presenceUsers, sendMessage, setTypingStatus, connected };
}
```

---

### 4. Server-Sent Events (SSE) — Express

```typescript
// src/routes/notifications.ts
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';

export const notificationsRouter = Router();

// In-memory map of userId -> response objects (use Redis pub/sub for multi-server)
const clients = new Map<string, Set<Response>>();

export function broadcastToUser(userId: string, event: string, data: unknown) {
  const userClients = clients.get(userId);
  if (!userClients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of userClients) {
    try {
      res.write(payload);
    } catch {
      userClients.delete(res);
    }
  }
}

export function broadcastToAll(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, userClients] of clients) {
    for (const res of userClients) {
      try { res.write(payload); } catch { /* ignore */ }
    }
  }
}

// GET /api/v1/notifications/stream
notificationsRouter.get('/stream', requireAuth, (req: Request, res: Response) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const userId = req.user.sub;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(res);

  // Keep-alive heartbeat every 25s
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.get(userId)?.delete(res);
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  });
});

// Usage from elsewhere in your server:
// broadcastToUser(userId, 'notification', { title: 'New message', body: '...' });
// broadcastToUser(userId, 'ticket:updated', { ticketId, status });
```

---

### 5. SSE — Next.js App Router (Streaming Route Handler)

```typescript
// app/api/notifications/stream/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// Map from userId to controller (per-process only — use Redis for multi-instance)
const controllers = new Map<string, Set<ReadableStreamDefaultController>>();

export function pushToUser(userId: string, event: string, data: unknown) {
  const userControllers = controllers.get(userId);
  if (!userControllers) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of userControllers) {
    try {
      ctrl.enqueue(new TextEncoder().encode(payload));
    } catch {
      userControllers.delete(ctrl);
    }
  }
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.id;

  const stream = new ReadableStream({
    start(controller) {
      if (!controllers.has(userId)) controllers.set(userId, new Set());
      controllers.get(userId)!.add(controller);

      // Send initial connected event
      const msg = `event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
      controller.enqueue(new TextEncoder().encode(msg));

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(':heartbeat\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);

      // Cleanup when client disconnects
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        controllers.get(userId)?.delete(controller);
        if (controllers.get(userId)?.size === 0) controllers.delete(userId);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

---

### 6. React SSE Client Hook

```tsx
// src/hooks/useSSE.ts
'use client';

import { useEffect, useRef, useCallback } from 'react';

type SSEHandler = (data: unknown) => void;

interface UseSSEOptions {
  url: string;
  enabled?: boolean;
  withCredentials?: boolean;
}

export function useSSE({ url, enabled = true, withCredentials = true }: UseSSEOptions) {
  const handlersRef = useRef<Map<string, SSEHandler[]>>(new Map());
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource(url, { withCredentials });
    sourceRef.current = source;

    // Generic message dispatcher
    const handleEvent = (event: MessageEvent, eventType: string) => {
      const handlers = handlersRef.current.get(eventType) ?? [];
      let data: unknown;
      try { data = JSON.parse(event.data); } catch { data = event.data; }
      handlers.forEach((h) => h(data));
    };

    // Listen to all event types registered via on()
    source.onmessage = (e) => handleEvent(e, 'message');
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        console.warn('SSE connection closed');
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [url, enabled, withCredentials]);

  const on = useCallback((eventType: string, handler: SSEHandler) => {
    if (!handlersRef.current.has(eventType)) {
      handlersRef.current.set(eventType, []);
      // Attach native SSE event listener
      sourceRef.current?.addEventListener(eventType, (e) => {
        let data: unknown;
        try { data = JSON.parse((e as MessageEvent).data); } catch { data = (e as MessageEvent).data; }
        (handlersRef.current.get(eventType) ?? []).forEach((h) => h(data));
      });
    }
    handlersRef.current.get(eventType)!.push(handler);

    return () => {
      const handlers = handlersRef.current.get(eventType) ?? [];
      handlersRef.current.set(eventType, handlers.filter((h) => h !== handler));
    };
  }, []);

  return { on };
}

// Usage:
// const { on } = useSSE({ url: '/api/notifications/stream' });
// useEffect(() => on('ticket:updated', (data) => { ... }), [on]);
```

---

### 7. Typing Indicator Component

```tsx
// src/components/TypingIndicator.tsx
'use client';

interface TypingIndicatorProps {
  users: string[];
}

export function TypingIndicator({ users }: TypingIndicatorProps) {
  if (users.length === 0) return null;

  const label =
    users.length === 1
      ? `${users[0]} is typing...`
      : users.length === 2
      ? `${users[0]} and ${users[1]} are typing...`
      : `${users[0]} and ${users.length - 1} others are typing...`;

  return (
    <div className="flex items-center gap-2 px-4 py-1 text-sm text-gray-500">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}
```

---

## Common Mistakes

- **Not implementing WebSocket heartbeats**: Idle connections behind load balancers or NAT are dropped silently after 30-90 seconds. Always implement ping/pong or a periodic heartbeat and terminate dead sockets.

- **Storing SSE response objects in a global Map without cleanup**: If the client disconnects and you do not listen to `req.on('close', ...)` (Express) or `req.signal.addEventListener('abort', ...)` (Next.js), you accumulate dead response objects and will eventually OOM.

- **Using Socket.io without a Redis adapter on multi-process deployments**: Without the adapter, `io.to(roomId).emit(...)` only reaches clients connected to the current process. Always use the Redis adapter in production.

- **Sending entire message history over WebSocket on join**: Only send recent history (last 50 messages) fetched from the DB. Load older history on scroll via REST API pagination.

- **Not rate limiting WebSocket message sends**: A single malicious client can flood a room. Track messages per second per user and disconnect or throttle clients that exceed limits.

- **Broadcasting to self when it should be excluded**: Use `socket.to(room)` (Socket.io) or the `exclude` parameter in your `broadcast()` function to skip sending back to the sender for `typing` events.

- **Forgetting `X-Accel-Buffering: no` for SSE behind nginx**: Nginx buffers responses by default, which breaks SSE. Always set this header.

---

## Framework-Specific Notes

### Next.js

- Stateful WebSocket servers cannot run inside Next.js itself. Run a separate WebSocket/Socket.io server (e.g., on a different port or subdomain) and connect the client to that URL.
- SSE Route Handlers work natively in the App Router using `ReadableStream`. They are stateless per request — the controller reference must be stored somewhere (module-level Map, Redis, etc.) to push events later.
- Use `export const dynamic = 'force-dynamic'` on SSE route segments to prevent Next.js from statically generating them.

### Express

- Attach the Socket.io server to the same HTTP server as Express: `const httpServer = createServer(app); createSocketServer(httpServer);` — they share the same port.
- For SSE, disable Express body parsing middleware on the SSE route since you are not parsing a body.
- In a PM2/cluster setup, Socket.io's Redis adapter is mandatory. Without it, rooms and broadcasts are scoped to a single worker process.
