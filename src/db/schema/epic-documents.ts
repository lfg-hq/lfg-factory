import * as sq from "./sqlite/epic-documents.ts";
import * as pg from "./pg/epic-documents.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const epicDocuments = m.epicDocuments;
