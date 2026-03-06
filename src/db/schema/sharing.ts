import * as sq from "./sqlite/sharing.ts";
import * as pg from "./pg/sharing.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const shareLinks = m.shareLinks;
