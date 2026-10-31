import * as sq from './sqlite/git-mutations.ts';
import * as pg from './pg/git-mutations.ts';
const m = (process.env.DATABASE_DRIVER === 'postgresql' ? pg : sq) as typeof sq;
export const gitMutations = m.gitMutations;
