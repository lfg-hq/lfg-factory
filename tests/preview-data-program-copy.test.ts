// LFG Desktop runs its own copy of the preview data program; it must match the server's.
import { expect, test } from "bun:test";
import { previewDataProgram } from "../src/services/preview-data-program.ts";
import { PREVIEW_DATA_PROGRAM } from "../desktop/src/preview-data-program.ts";

test("desktop's preview data program is the server's (regenerate: bun desktop/scripts/copy-data-program.ts)", () => {
  expect(PREVIEW_DATA_PROGRAM).toBe(previewDataProgram());
});
