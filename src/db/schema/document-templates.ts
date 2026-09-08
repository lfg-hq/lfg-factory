import * as sq from "./sqlite/document-templates.ts";
import * as pg from "./pg/document-templates.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const documentTemplates = m.documentTemplates;
