import * as sq from "./sqlite/venture.ts";
import * as pg from "./pg/venture.ts";
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as typeof sq;
export const { ventureConversations, ventureMessages, ventureSources, ventureAssessments } = m;
