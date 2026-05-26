import * as sq from "./sqlite/composio.ts";
import * as pg from "./pg/composio.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const composioToolkits = m.composioToolkits;
