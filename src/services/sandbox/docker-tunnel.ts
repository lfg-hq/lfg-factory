/**
 * Host-side TCP tunnels into a container's loopback, carried over `docker exec -i`.
 *
 * Docker can't publish a port on a running container, and Chromium binds its
 * DevTools port to 127.0.0.1 regardless of --remote-debugging-address. Piping each
 * connection through `docker exec` reaches any loopback port in any container on
 * macOS and Linux alike, without publishing anything or exposing it off-host.
 */
import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";

const tunnels = new Map<string, Promise<{ server: Server; port: number; sockets: Set<Socket> }>>();

/** Pipes stdin/stdout to 127.0.0.1:PORT with whatever the image has (node, python3, or busybox nc). */
export function bridgeScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const node = `const s=require('net').connect(${port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));`;
  const py = [
    "import socket,sys,threading,os",
    `s=socket.create_connection(('127.0.0.1',${port}))`,
    "def up():",
    " while True:",
    "  d=os.read(0,65536)",
    "  if not d: break",
    "  s.sendall(d)",
    " try: s.shutdown(socket.SHUT_WR)",
    " except OSError: pass",
    "threading.Thread(target=up,daemon=True).start()",
    "while True:",
    " d=s.recv(65536)",
    " if not d: break",
    " os.write(1,d)",
  ].join("\n");
  const b64 = Buffer.from(py).toString("base64");
  return `if command -v node >/dev/null 2>&1; then exec node -e "${node}"; ` +
    `elif command -v python3 >/dev/null 2>&1; then exec python3 -c "import base64;exec(base64.b64decode('${b64}'))"; ` +
    `else exec nc 127.0.0.1 ${port}; fi`;
}

function pipe(container: string, port: number, socket: Socket, docker: string) {
  const child = spawn(docker, ["exec", "-i", container, "sh", "-c", bridgeScript(port)], { stdio: ["pipe", "pipe", "ignore"] });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  const end = () => { socket.destroy(); child.kill(); };
  socket.on("error", end);
  socket.on("close", () => child.kill());
  child.on("error", end);
  child.on("close", () => socket.end());
  child.stdin.on("error", () => {});
}

/** A 127.0.0.1 port on this host that forwards to `port` inside `container`. Reused per (container, port). */
export function dockerTunnel(container: string, port: number, docker = "docker"): Promise<number> {
  const key = `${container}:${port}`;
  let entry = tunnels.get(key);
  if (!entry) {
    entry = new Promise((resolve, reject) => {
      const sockets = new Set<Socket>();
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        pipe(container, port, socket, docker);
      });
      server.on("error", reject);
      // A tunnel must never keep the LFG process alive on its own.
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, sockets }));
    });
    entry.catch(() => tunnels.delete(key));
    tunnels.set(key, entry);
  }
  return entry.then(t => t.port);
}

/** Close every tunnel into a container (it was stopped or removed). */
export async function closeDockerTunnels(container: string): Promise<void> {
  for (const [key, entry] of tunnels) {
    if (!key.startsWith(container + ":")) continue;
    tunnels.delete(key);
    // close() waits for open connections (a CDP websocket can linger): end them first.
    await entry.then(t => new Promise<void>(r => { t.server.close(() => r()); for (const s of t.sockets) s.destroy(); })).catch(() => {});
  }
}
