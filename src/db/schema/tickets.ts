import * as sq from "./sqlite/tickets.ts";
import * as pg from "./pg/tickets.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const ticketStages = m.ticketStages;
export const projectTickets = m.projectTickets;
export const ticketMergeHistory = m.ticketMergeHistory;
export const projectTodoLists = m.projectTodoLists;
export const ticketLogs = m.ticketLogs;
export const projectTicketAttachments = m.projectTicketAttachments;
export const ticketAddenda = m.ticketAddenda;
