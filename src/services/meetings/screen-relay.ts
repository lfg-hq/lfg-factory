/**
 * Relays a meeting-bot seat's screen (noVNC's websocket) between an admin's browser and the
 * seat's Mags browser, so the admin can sign the seat in to Google without ever being given
 * the Mags URL, which holds the browser's secret. Opened from /ws/meeting-bot-screen in
 * index.ts after the admin's LFG session and open sign-in are checked.
 */
import type { ServerWebSocket } from "bun";

export interface ScreenRelay {
  upstreamUrl: string;
  protocol?: string;
  upstream?: WebSocket;
  queue: (string | Uint8Array)[];
}

type Socket = ServerWebSocket<{ screen?: ScreenRelay }>;

export const screenRelay = {
  open(ws: Socket) {
    const relay = ws.data.screen!;
    const upstream = new WebSocket(relay.upstreamUrl, relay.protocol ? [relay.protocol] : undefined);
    upstream.binaryType = "arraybuffer";
    relay.upstream = upstream;
    upstream.onopen = () => {
      for (const data of relay.queue.splice(0)) upstream.send(data);
    };
    upstream.onmessage = (event) => {
      ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
    };
    upstream.onclose = () => ws.close(1000, "The seat's screen closed.");
    upstream.onerror = () => ws.close(1011, "The seat's screen is not available.");
  },
  message(ws: Socket, data: string | Buffer) {
    const relay = ws.data.screen!;
    const payload = typeof data === "string" ? data : new Uint8Array(data);
    if (relay.upstream?.readyState === WebSocket.OPEN) relay.upstream.send(payload);
    else relay.queue.push(payload);
  },
  close(ws: Socket) {
    const relay = ws.data.screen;
    relay?.upstream?.close();
    if (relay) relay.queue.length = 0;
  },
};
