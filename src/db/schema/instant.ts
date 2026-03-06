import * as sq from "./sqlite/instant.ts";
import * as pg from "./pg/instant.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const instantApps = m.instantApps;
