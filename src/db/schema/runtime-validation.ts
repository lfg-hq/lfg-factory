import * as sq from "./sqlite/runtime-validation.ts";
import * as pg from "./pg/runtime-validation.ts";
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as typeof sq;
export const runtimeValidations = m.runtimeValidations;
