// LFG Ventures: the AI venture analyst, its assessments and funding decisions,
// and the founder/reviewer dashboard. Everything venture-specific lives here:
//   routes/     HTTP: pages, /api/venture, Google sign-in
//   services/   analyst turns, assessment schema, dashboard data, access rules
//   prompts/    analyst and assessment system prompts
//   db/         Drizzle tables (sqlite.ts and pg.ts mirror each other)
//   templates/  landing, chat and dashboard page shells
// Browser code is in public/venture/.
export { default as ventureApi } from "./routes/api.ts";
export { default as venturePages } from "./routes/pages.ts";
export { default as ventureAuth, handleGoogleCallback } from "./routes/auth.ts";
