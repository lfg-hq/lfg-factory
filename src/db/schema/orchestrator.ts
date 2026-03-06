import * as sq from "./sqlite/orchestrator.ts";
import * as pg from "./pg/orchestrator.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const agentRuns = m.agentRuns;
export const ticketExecutions = m.ticketExecutions;
export const ticketExecutionDependencies = m.ticketExecutionDependencies;
export const agentEvents = m.agentEvents;
