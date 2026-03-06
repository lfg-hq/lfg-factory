import * as sq from "./sqlite/projects.ts";
import * as pg from "./pg/projects.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projects = m.projects;
export const projectMembers = m.projectMembers;
export const projectInvitations = m.projectInvitations;
export const projectEnvironmentVariables = m.projectEnvironmentVariables;
export const projectCodeGenerations = m.projectCodeGenerations;
