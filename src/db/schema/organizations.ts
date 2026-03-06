import * as sq from "./sqlite/organizations.ts";
import * as pg from "./pg/organizations.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const organizations = m.organizations;
export const orgMemberships = m.orgMemberships;
export const orgInvitations = m.orgInvitations;
