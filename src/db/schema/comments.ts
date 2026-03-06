import * as sq from "./sqlite/comments.ts";
import * as pg from "./pg/comments.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const documentComments = m.documentComments;
