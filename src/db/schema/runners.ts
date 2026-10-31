import * as sq from "./sqlite/runners.ts";
import * as pg from "./pg/runners.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const runnerDevices = m.runnerDevices;
export const runnerJobs = m.runnerJobs;
