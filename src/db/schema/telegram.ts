import * as sq from "./sqlite/telegram.ts";
import * as pg from "./pg/telegram.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const telegramBots = m.telegramBots;
