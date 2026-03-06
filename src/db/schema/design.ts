import * as sq from "./sqlite/design.ts";
import * as pg from "./pg/design.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const projectDesignFeatures = m.projectDesignFeatures;
export const designCanvases = m.designCanvases;
