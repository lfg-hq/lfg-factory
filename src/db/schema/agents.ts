import * as sq from "./sqlite/agents.ts";
import * as pg from "./pg/agents.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const agents = m.agents;
export const agentSchedules = m.agentSchedules;
export const agentDataFiles = m.agentDataFiles;
export const agentMessages = m.agentMessages;
export const agentSecrets = m.agentSecrets;
export const agentTaskRuns = m.agentTaskRuns;
