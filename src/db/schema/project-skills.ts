import * as sq from "./sqlite/project-skills.ts";
import * as pg from "./pg/project-skills.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectSkills = m.projectSkills;
