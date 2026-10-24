import * as sq from "./sqlite/document-sync.ts";
import * as pg from "./pg/document-sync.ts";
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as typeof sq;
export const { documentSyncTargets, documentSyncLinks } = m;
