import * as sq from "./sqlite/activities.ts";
import * as pg from "./pg/activities.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectActivities = m.projectActivities;
export const ACTIVITY_TYPES = sq.ACTIVITY_TYPES; // constant, same in both dialects

export type ProjectActivity = sq.ProjectActivity;
export type NewProjectActivity = sq.NewProjectActivity;
