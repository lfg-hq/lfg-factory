import * as sq from "./sqlite/project-environments.ts";
import * as pg from "./pg/project-environments.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectEnvironments = m.projectEnvironments;
