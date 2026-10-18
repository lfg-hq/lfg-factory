import * as sq from "./sqlite/document-graph.ts";
import * as pg from "./pg/document-graph.ts";
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as typeof sq;
export const { documentGraphs, documentGraphSources, documentGraphLinks } = m;
