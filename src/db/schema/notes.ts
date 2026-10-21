import * as sq from "./sqlite/notes.ts";
import * as pg from "./pg/notes.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectNotes = m.projectNotes;
