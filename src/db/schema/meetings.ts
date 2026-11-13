import * as sq from "./sqlite/meetings.ts";
import * as pg from "./pg/meetings.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const meetings = m.meetings;
export const meetingSegments = m.meetingSegments;
