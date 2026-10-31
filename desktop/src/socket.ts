import WebSocket from "ws";
import type { SocketFactory, SocketLike } from "./runner.ts";

/** Node WebSocket (the `ws` package) with headers, for Electron's main process and the CLI. */
export const nodeSocketFactory: SocketFactory = (url, headers) => {
  // autoSelectFamily: try IPv6 and IPv4 ("localhost" is ::1 first on Node 18, while many servers listen on IPv4 only).
  const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000, autoSelectFamily: true } as WebSocket.ClientOptions);
  const socket = ws as unknown as SocketLike & { unauthorized?: boolean };
  // A rejected handshake surfaces as "Unexpected server response: 401" before close.
  ws.on("error", (e: Error) => { if (/\b401\b/.test(e.message)) socket.unauthorized = true; });
  return socket;
};
