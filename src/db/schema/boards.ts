import * as sq from "./sqlite/boards.ts";
import * as pg from "./pg/boards.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const boardConnections = m.boardConnections;
export const boardLinks = m.boardLinks;
export const ticketBoardLinks = m.ticketBoardLinks;
