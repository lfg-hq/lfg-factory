import * as sq from "./sqlite/chat.ts";
import * as pg from "./pg/chat.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const agentRoles = m.agentRoles;
export const conversations = m.conversations;
export const messages = m.messages;
export const chatFiles = m.chatFiles;
export const modelSelections = m.modelSelections;
