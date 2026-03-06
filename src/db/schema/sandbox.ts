import * as sq from "./sqlite/sandbox.ts";
import * as pg from "./pg/sandbox.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const sandboxes = m.sandboxes;
export const serverLogs = m.serverLogs;
