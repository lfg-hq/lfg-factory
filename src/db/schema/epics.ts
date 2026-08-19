import * as sq from "./sqlite/epics.ts";
import * as pg from "./pg/epics.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const epics = m.epics;
