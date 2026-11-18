// A preview on the person's computer can't use Env values written for the cloud preview.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizeEnv, secretsTheAppReads } from "../desktop/src/preview.ts";

test("addresses of the cloud preview point at localhost; other addresses don't change", () => {
  const changes = localizeEnv({
    BETTER_AUTH_URL: "https://preview-18034ff75e2f46f4a38b.app.lfg.run",
    CALLBACK_PUBLIC_URL: "https://preview-18034ff75e2f46f4a38b.app.lfg.run/api/calls",
    API_URL: "https://preview-abc-api.app.lfg.run/v1",
    CUSTOM: "https://my-preview.example.dev/x",
    OPENAI_BASE: "https://api.openai.com/v1",
  }, ["https://my-preview.example.dev"], [{ name: "web", port: 8080 }, { name: "api", port: 4000 }]);
  expect(Object.fromEntries(changes.map(c => [c.key, c.value]))).toEqual({
    BETTER_AUTH_URL: "http://localhost:8080",
    CALLBACK_PUBLIC_URL: "http://localhost:8080/api/calls",
    API_URL: "http://localhost:4000/v1",
    CUSTOM: "http://localhost:8080/x",
  });
});

test("signing secrets the app reads are found; outside-service credentials are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "lfg-secrets-"));
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  writeFileSync(join(dir, "src/lib/auth.ts"), "export const a = { secret: process.env.BETTER_AUTH_SECRET, url: process.env.BETTER_AUTH_URL, s: process.env['JWT_SECRET'] };");
  writeFileSync(join(dir, "src/lib/pay.ts"), "const k = process.env.STRIPE_SECRET_KEY; const g = process.env.GOOGLE_CLIENT_SECRET;");
  writeFileSync(join(dir, "app.py"), "import os\nKEY = os.environ.get('SECRET_KEY')\n");
  writeFileSync(join(dir, "node_modules/x/index.js"), "process.env.SESSION_SECRET");
  expect(secretsTheAppReads(dir)).toEqual(["BETTER_AUTH_SECRET", "JWT_SECRET", "SECRET_KEY"]);
});
