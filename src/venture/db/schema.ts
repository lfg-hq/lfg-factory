import * as sq from "./sqlite.ts";
import * as pg from "./pg.ts";
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as typeof sq;
export const { ventureConversations, ventureMessages, ventureSources, ventureAssessments, ventureDecisions, ventureTasks, ventureWorkItems, ventureEvents, ventureMetrics, ventureAgreements, ventureAgreementMessages } = m;
