import * as sq from "./sqlite/project-databases.ts";
import * as pg from "./pg/project-databases.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectDatabases = m.projectDatabases;
