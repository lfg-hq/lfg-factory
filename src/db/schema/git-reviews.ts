import * as sq from './sqlite/git-reviews.ts';
import * as pg from './pg/git-reviews.ts';
const m = (process.env.DATABASE_DRIVER === 'postgresql' ? pg : sq) as typeof sq;
export const gitReviews = m.gitReviews;
export const gitOperations = m.gitOperations;
