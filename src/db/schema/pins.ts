import * as sq from "./sqlite/pins.ts";
import * as pg from "./pg/pins.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectPins = m.projectPins;
