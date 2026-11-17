import { expect, test } from "bun:test";
import { chatSummary, plainText } from "../src/services/chat-summary.ts";

test("strips markdown down to readable text", () => {
  expect(plainText("## Plan\n\n- **First** thing\n| a | b |\n```js\ncode\n```\nSee [the PRD](file:1")).toBe("Plan First thing See the PRD");
});
test("summarises from the agent's last reply and ends on a sentence", () => {
  const long = "I found the context I need. " + "This sentence pads the reply well past the limit so it must be cut. ".repeat(5);
  const s = chatSummary([{ role: "user", content: "ok" }, { role: "assistant", content: long }])!;
  expect(s.failed).toBe(false);
  expect(s.text.length).toBeLessThanOrEqual(221);
  expect(s.text.endsWith(".")).toBe(true);
});
test("flags a chat whose last reply was an error", () => {
  expect(chatSummary([{ role: "assistant", content: "\n\n*Error: DeepSeek has insufficient API credit.*" }, { role: "user", content: "status?" }]))
    .toEqual({ text: "DeepSeek has insufficient API credit.", failed: true });
});
test("falls back to the user's message, and to nothing for an empty chat", () => {
  expect(chatSummary([{ role: "user", content: "Plan the export" }])).toEqual({ text: "Plan the export", failed: false });
  expect(chatSummary([])).toBeNull();
});
