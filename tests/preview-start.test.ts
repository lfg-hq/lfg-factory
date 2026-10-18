import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { PreviewRunQueue } from "../src/services/preview-run-queue.ts";

test("three simultaneous starts reserve separate turns on the same sandbox", async () => {
  const queue = new PreviewRunQueue();
  const releaseFirst = await queue.acquire("project");
  const order: number[] = [];
  const second = queue.acquire("project").then(release => { order.push(2); return release; });
  const third = queue.acquire("project").then(release => { order.push(3); return release; });
  releaseFirst();
  const releaseSecond = await second;
  await Promise.resolve();
  expect(order).toEqual([2]);
  releaseFirst(); // A repeated cleanup must not release another run.
  await Promise.resolve();
  expect(order).toEqual([2]);
  releaseSecond();
  const releaseThird = await third;
  expect(order).toEqual([2, 3]);
  releaseThird();
  (await queue.acquire("project"))();
});

test("different projects can prepare their own sandboxes concurrently", async () => {
  const queue = new PreviewRunQueue();
  const first = await queue.acquire("a");
  const second = await queue.acquire("b");
  second(); first();
});

test("a stopped poll started before Start cannot replace the progress view", async () => {
  const js = readFileSync(new URL("../public/js/preview-tab.js", import.meta.url), "utf8");
  const load = js.slice(js.indexOf("  async function load()"), js.indexOf("  const statusView ="));
  let respond!: (value: unknown) => void;
  const rendered: unknown[] = [];
  const polling: unknown[] = [];
  const context = vm.createContext({projectId: "p", stateVersion: 0, current: {}, currentView: "progress",
    logText: "", manifest: null, stepsData: [], console,
    api: () => new Promise(resolve => { respond = resolve; }),
    statusView: () => "idle", render: (state: unknown) => rendered.push(state),
    managePolling: (status: unknown) => polling.push(status)});
  vm.runInContext(load, context);
  const pending = vm.runInContext("load()", context);
  vm.runInContext("stateVersion++", context); // User starts, or newer WS progress arrives.
  respond({ok: true, json: async () => ({previewStatus: "stopped"})});
  await pending;
  expect(rendered).toEqual([]);
  expect(polling).toEqual([]);
  const fresh = vm.runInContext("load()", context);
  respond({ok: true, json: async () => ({previewStatus: "error", error: "Actual start failure"})});
  await fresh;
  expect(rendered).toEqual([{previewStatus: "error", error: "Actual start failure"}]);
  expect(polling).toEqual(["error"]);
});

test("epic restart publishes progress before waiting for sandbox readiness", async () => {
  const source = readFileSync(new URL("../src/services/dev-preview.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function restartPreview(projectId:"), source.indexOf("/** Stop the running app"));
  const js = new Bun.Transpiler({loader: "ts"}).transformSync(fn.replace("export async", "async"));
  const events: string[] = [];
  const context = vm.createContext({
    getEnv: async () => ({setupManifest: "{}", runCommand: "start", setupComplete: 1}),
    loadAppProfile: async () => null, loadPublicId: async () => {}, resetLog: () => {},
    acquirePreviewRun: async () => () => {},
    setPreview: async (_p: string, _u: string, state: any) => events.push(state.previewStatus),
    persistSteps: async () => {},
    ensureProjectSandbox: async () => { events.push("sandbox"); throw new Error("VM unavailable"); },
    isCancelled: () => false, failureSummary: (s: string) => s,
    failed: async (_p: string, _u: string, error: string) => ({error}),
    cancelledProjects: new Set(), activeProfileBranches: new Map(), driverFailures: new Map(),
  });
  vm.runInContext(js, context);
  const result = await vm.runInContext('restartPreview("p", {userId:"u", branch:"epic/inv-e1"})', context);
  expect(events).toEqual(["provisioning", "sandbox"]);
  expect(result.error).toBe("VM unavailable");
});
