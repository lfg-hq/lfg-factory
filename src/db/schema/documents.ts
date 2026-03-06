import * as sq from "./sqlite/documents.ts";
import * as pg from "./pg/documents.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectFiles = m.projectFiles;
export const projectFileVersions = m.projectFileVersions;
export const toolCallHistory = m.toolCallHistory;
