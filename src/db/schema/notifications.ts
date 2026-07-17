import * as sq from "./sqlite/notifications.ts";
import * as pg from "./pg/notifications.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const notifications = m.notifications;
