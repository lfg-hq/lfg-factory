// LFG Desktop notices a dead connection: after sleep or a network change the socket can
// look open while nothing arrives. Silence from a server that pings → reconnect.
import { test, expect } from "bun:test";
import { Runner, type SocketLike } from "../desktop/src/runner.ts";

function fakeSockets() {
  const made: Array<SocketLike & { closedWith?: number }> = [];
  const create = () => {
    const socket: SocketLike & { closedWith?: number } = {
      readyState: 1, send() {}, close(code) { socket.closedWith = code ?? 1000; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    made.push(socket);
    return socket;
  };
  return { made, create };
}
const none = { claude: "/nonexistent/claude", codex: "/nonexistent/codex", copilot: "/nonexistent/copilot" };

test("a server that pinged and then went silent is dropped and reconnected", async () => {
  const { made, create } = fakeSockets();
  const runner = new Runner({ serverUrl: "http://lfg.test", token: "t", workRoot: "/tmp/lfg-wd", createSocket: create,
    approve: async () => ({ approved: false }), agentBins: none, livenessMs: 150 });
  runner.start();
  const first = made[0]!;
  first.onmessage!({ data: JSON.stringify({ type: "welcome", deviceId: "d", deviceName: "Mac", protocol: 2 }) });
  first.onmessage!({ data: JSON.stringify({ type: "ping" }) });
  await Bun.sleep(400);
  runner.stop();
  expect(made.length).toBeGreaterThanOrEqual(2);
  expect(first.closedWith).toBe(4000);
});

test("a connection that keeps hearing pings is left alone", async () => {
  const { made, create } = fakeSockets();
  const runner = new Runner({ serverUrl: "http://lfg.test", token: "t", workRoot: "/tmp/lfg-wd", createSocket: create,
    approve: async () => ({ approved: false }), agentBins: none, livenessMs: 150 });
  runner.start();
  const first = made[0]!;
  first.onmessage!({ data: JSON.stringify({ type: "welcome", deviceId: "d", deviceName: "Mac", protocol: 2 }) });
  for (let i = 0; i < 8; i++) { first.onmessage!({ data: JSON.stringify({ type: "ping" }) }); await Bun.sleep(50); }
  runner.stop();
  expect(made.length).toBe(1);
});

test("waking from sleep reconnects at once", () => {
  const { made, create } = fakeSockets();
  const runner = new Runner({ serverUrl: "http://lfg.test", token: "t", workRoot: "/tmp/lfg-wd", createSocket: create,
    approve: async () => ({ approved: false }), agentBins: none });
  runner.start();
  runner.reconnectNow("woke from sleep");
  runner.stop();
  expect(made.length).toBe(2);
  expect(made[0]!.closedWith).toBe(4000);
});
