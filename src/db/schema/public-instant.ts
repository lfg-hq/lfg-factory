import * as sq from "./sqlite/public-instant.ts";
import * as pg from "./pg/public-instant.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const publicInstantChats = m.publicInstantChats;
