import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { bridgeScript, closeDockerTunnels, dockerTunnel } from "../src/services/sandbox/docker-tunnel.ts";

// A stand-in for `docker exec -i <container> sh -c <script>` that runs the script locally.
async function fakeDocker(): Promise<string> {
  const dir = await mkdtemp(tmpdir() + "/fake-docker-");
  const bin = dir + "/docker";
  await writeFile(bin, '#!/bin/sh\nshift 3\nexec "$@"\n');
  await chmod(bin, 0o755);
  return bin;
}

describe("docker exec tunnel", () => {
  test("forwards HTTP to a loopback-only port and closes cleanly", async () => {
    const app = createServer((_, res) => res.end("hello from the sandbox"));
    await new Promise<void>(r => app.listen(0, "127.0.0.1", () => r()));
    const appPort = (app.address() as { port: number }).port;
    const docker = await fakeDocker();
    const port = await dockerTunnel("lfg-test", appPort, docker);
    expect(await dockerTunnel("lfg-test", appPort, docker)).toBe(port);
    for (let i = 0; i < 3; i++) {
      const body = await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" } }).then(r => r.text());
      expect(body).toBe("hello from the sandbox");
    }
    await closeDockerTunnels("lfg-test");
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    app.close();
  });

  test("rejects invalid ports", () => {
    expect(() => bridgeScript(0)).toThrow();
    expect(() => bridgeScript(70000)).toThrow();
    expect(bridgeScript(3000)).toContain("3000");
  });
});
