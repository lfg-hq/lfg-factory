import * as sq from "./sqlite/users.ts";
import * as pg from "./pg/users.ts";

type S = typeof sq;
const m = (process.env.DATABASE_DRIVER === "postgresql" ? pg : sq) as S;

export const users = m.users;
export const sessions = m.sessions;
export const accounts = m.accounts;
export const verifications = m.verifications;
export const profiles = m.profiles;
export const llmApiKeys = m.llmApiKeys;
export const externalServicesApiKeys = m.externalServicesApiKeys;
export const applicationState = m.applicationState;
export const githubTokens = m.githubTokens;
export const gitlabTokens = m.gitlabTokens;
export const emailVerificationTokens = m.emailVerificationTokens;
export const emailVerificationCodes = m.emailVerificationCodes;
