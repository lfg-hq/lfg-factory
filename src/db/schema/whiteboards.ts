import * as sq from "./sqlite/whiteboards.ts";
import * as pg from "./pg/whiteboards.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const whiteboards = m.whiteboards;
export const whiteboardMessages = m.whiteboardMessages;
