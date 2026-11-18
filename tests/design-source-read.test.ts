// A chat on the user's computer reaches LFG's tools over MCP, which binds them afresh for
// every request. Reading the app source in one request must still count when the next
// request saves a preview in the same turn — and not leak into another turn.
import { test, expect } from "bun:test";
import { withConversationContext } from "../src/ai/tools/conversation-context.ts";

const seen: Array<{ designSourceRead?: boolean; localCheckout?: boolean }> = [];
const tools = {
  readDesignSource: { execute: async () => ({ commit: "abc123", files: [{ path: "src/app.tsx", content: "<App/>" }] }) },
  captureDesignLayout: { execute: async () => ({}) },
  probe: { execute: async (_args: unknown, opts: any) => { seen.push({ designSourceRead: opts.designSourceRead, localCheckout: opts.localCheckout }); return {}; } },
};
const bind = (turn: string, local = false) => withConversationContext(tools, "conv-1", "user-1", "proj-1", turn, { localCheckout: local });

test("a source read carries over to a later request in the same turn", async () => {
  await bind("turn-A").readDesignSource.execute({ projectId: "proj-1" }, {});
  await bind("turn-A").probe.execute({ projectId: "proj-1" }, {});
  expect(seen.at(-1)?.designSourceRead).toBe(true);
});

test("another turn starts without it", async () => {
  await bind("turn-B").probe.execute({ projectId: "proj-1" }, {});
  expect(seen.at(-1)?.designSourceRead).toBe(false);
});

test("tools bound for a chat on the user's computer know it", async () => {
  await bind("turn-C", true).probe.execute({ projectId: "proj-1" }, {});
  expect(seen.at(-1)?.localCheckout).toBe(true);
  await bind("turn-C").probe.execute({ projectId: "proj-1" }, {});
  expect(seen.at(-1)?.localCheckout).toBe(false);
});
