import * as sq from "./sqlite/free-prd.ts";
import * as pg from "./pg/free-prd.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const freePrdRequests = m.freePrdRequests;
