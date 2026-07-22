import * as sq from "./sqlite/app-profile.ts";
import * as pg from "./pg/app-profile.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const appProfiles = m.appProfiles;
