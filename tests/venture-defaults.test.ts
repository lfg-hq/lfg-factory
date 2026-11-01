import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("development defaults boot on 8080 and retain a generated secret across restarts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "venture-defaults-"));
  const module = join(process.cwd(), "src/config/env.ts");
  const settings = { ...process.env, NODE_ENV: "development", BETTER_AUTH_SECRET: "", BETTER_AUTH_URL: undefined, PORT: undefined };
  try {
    const start = async () => {
      const child = Bun.spawn(["bun", "-e", `import {env} from ${JSON.stringify(module)}; if(env.PORT!==8080||env.BETTER_AUTH_URL!=="http://localhost:8080"||env.BETTER_AUTH_SECRET.length<32)process.exit(1);`], { cwd: temp, env: settings, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    };
    await start(); const path = join(temp, "data/.auth-secret"); const first = await readFile(path, "utf8");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await start(); expect(await readFile(path, "utf8")).toBe(first);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
