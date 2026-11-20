import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedUrl, findBrowser, readPreviews, resolveUrl, TOOL } from "../desktop/src/preview-browser.ts";
import { AGENTS } from "../desktop/src/agents.ts";

// A tiny app with a sign-in: the session cookie unlocks /dashboard.
function app(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const signedIn = (req.headers.cookie ?? "").includes("sid=ok");
    if (req.method === "POST" && req.url === "/login") {
      let body = ""; req.on("data", d => (body += d)); req.on("end", () => {
        const ok = new URLSearchParams(body).get("password") === "secret";
        res.writeHead(303, ok ? { "Set-Cookie": "sid=ok; Path=/; Max-Age=3600", Location: "/dashboard" } : { Location: "/login?error=1" }); res.end();
      });
      return;
    }
    if (req.url === "/dashboard") {
      if (!signedIn) { res.writeHead(303, { Location: "/login" }); res.end(); return; }
      res.setHeader("Content-Type", "text/html");
      res.end(`<h1>SDR calls</h1><button id="start">Start call</button><p role="status"></p><a href="https://example.com/">Docs</a><script>document.getElementById('start').addEventListener('click',()=>{document.querySelector('[role=status]').textContent='Call started'});setTimeout(()=>{throw new Error('widget crashed')},10)</script>`);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<h1>Welcome back</h1><form method="post" action="/login"><label>Work email <input name="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

class Mcp {
  private buffer = ""; private waiters = new Map<number, (v: any) => void>(); private id = 0;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", d => {
      this.buffer += d; let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) { const msg = JSON.parse(this.buffer.slice(0, nl)); this.buffer = this.buffer.slice(nl + 1); this.waiters.get(msg.id)?.(msg); }
    });
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise(r => { this.waiters.set(id, r); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async tool(args: Record<string, unknown>) { return (await this.request("tools/call", { name: "browser", arguments: args })).result as { content: any[]; isError: boolean }; }
  close() { this.child.stdin.end(); return new Promise(r => this.child.on("close", r)); }
}

const browserPath = findBrowser();
const root = mkdtempSync(join(tmpdir(), "preview-browser-"));
const stateFile = join(root, "running.json");
let site: { server: Server; port: number };

function start() {
  const child = spawn(process.execPath, ["desktop/src/preview-browser.ts"], {
    env: { ...process.env, LFG_PREVIEW_STATE: stateFile, LFG_PREVIEW_PROJECT: "proj-1", LFG_PREVIEW_PROFILE: join(root, "profile") },
  }) as ChildProcessWithoutNullStreams;
  return new Mcp(child);
}
const text = (r: { content: any[] }) => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");

beforeAll(async () => {
  site = await app();
  writeFileSync(stateFile, JSON.stringify({ previews: [
    { project: "proj-1", urls: [{ name: "web", url: `http://localhost:${site.port}`, port: site.port, primary: true }] },
    { project: "other", urls: [{ name: "web", url: "http://localhost:1", port: 1 }] },
  ] }));
});
afterAll(() => site.server.close());

describe("preview browser rules", () => {
  test("only this project's running previews can be opened", () => {
    const previews = readPreviews(stateFile, "proj-1");
    expect(previews.length).toBe(1);
    expect(allowedUrl(`http://localhost:${site.port}/x`, previews)).toBe(true);
    expect(allowedUrl(`http://127.0.0.1:${site.port}/`, previews)).toBe(true);
    expect(allowedUrl("http://localhost:1/", previews)).toBe(false);
    expect(allowedUrl(`http://evil.test:${site.port}/`, previews)).toBe(false);
    expect(allowedUrl(`http://user:pw@localhost:${site.port}/`, previews)).toBe(false);
    expect(resolveUrl("/login", previews)).toBe(`http://localhost:${site.port}/login`);
    expect(() => resolveUrl(undefined, [])).toThrow(/No preview is running/);
  });

  test("Claude Code gets the browser server and the preview folder", () => {
    const call = AGENTS.claude.invocation({ prompt: "hi", cwd: "/tmp", readOnly: true, mcp: { url: "https://lfg.test/mcp", token: "t" },
      localMcp: { preview: { command: "/bin/node", args: ["pb.js"], env: { A: "1" } } }, addDirs: ["/work/previews/p"] });
    const config = JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]!);
    expect(config.mcpServers.preview).toEqual({ type: "stdio", command: "/bin/node", args: ["pb.js"], env: { A: "1" } });
    expect(config.mcpServers.lfg.type).toBe("http");
    expect(call.args[call.args.indexOf("--allowedTools") + 1]).toContain("mcp__preview");
    expect(call.args[call.args.indexOf("--add-dir") + 1]).toBe("/work/previews/p");
  });
});

describe.skipIf(!browserPath)("preview browser over MCP (needs Chrome)", () => {
  test("signs in, uses the feature, shows screenshots and stays on the preview", async () => {
    const mcp = start();
    try {
      const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(init.result.capabilities.tools).toBeDefined();
      const list = await mcp.request("tools/list");
      expect(list.result.tools[0].name).toBe(TOOL.name);

      const opened = await mcp.tool({ action: "open", url: "/login" });
      expect(opened.isError).toBe(false);
      expect(text(opened)).toContain("HTTP 200");

      const miss = await mcp.tool({ action: "click", locator: { role: "button", name: "Log in" } });
      expect(miss.isError).toBe(true);
      expect(text(miss)).toContain('button "Sign in"'); // the tree shows the right name
      expect(miss.content.some(c => c.type === "image")).toBe(true);

      await mcp.tool({ action: "fill", locator: { label: "Work email" }, value: "rep@example.com" });
      await mcp.tool({ action: "fill", locator: { label: "Password" }, value: "secret" });
      const signedIn = await mcp.tool({ action: "click", locator: { role: "button", name: "Sign in" } });
      expect(text(signedIn)).toContain("/dashboard");

      const call = await mcp.tool({ action: "click", locator: { role: "button", name: "Start call" }, screenshot: true });
      expect(call.isError).toBe(false);
      expect(text(signedIn) + text(call)).toContain("widget crashed"); // page errors are reported (when the dashboard loaded)
      expect(call.content.find(c => c.type === "image")?.data.length).toBeGreaterThan(1000);
      expect(text(await mcp.tool({ action: "read", locator: { role: "status" } }))).toContain("Call started");

      const away = await mcp.tool({ action: "open", url: "https://example.com/" });
      expect(away.isError).toBe(true);
      expect(text(away)).toContain("Only the preview's own addresses");
      await mcp.tool({ action: "click", locator: { role: "link", name: "Docs" } });
      const after = await mcp.tool({ action: "snapshot" });
      expect(text(after)).toContain("/dashboard"); // the link was blocked
    } finally { await mcp.close(); }

    // A new chat message starts a new server: the sign-in is still there.
    const again = start();
    try {
      const back = await again.tool({ action: "open", url: "/dashboard" });
      expect(text(back)).toContain("SDR calls");
    } finally { await again.close(); }
  }, 90_000);
});
