import * as sq from "./sqlite/evals.ts";
import * as pg from "./pg/evals.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const evalSuites = m.evalSuites;
export const evalRuns = m.evalRuns;
export const evalResults = m.evalResults;
