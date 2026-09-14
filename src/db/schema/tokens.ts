import * as sq from "./sqlite/tokens.ts";
import * as pg from "./pg/tokens.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const tokenUsage = m.tokenUsage;

export const tokenUsageRuns = m.tokenUsageRuns;
export const tokenUsageDocuments = m.tokenUsageDocuments;

export const tokenUsageTickets = m.tokenUsageTickets;
