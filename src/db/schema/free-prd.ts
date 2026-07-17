// Postgres-only schema shim for the free PRD requests table.
// (This deployment runs DATABASE_DRIVER=postgresql; no sqlite variant needed.)
export { freePrdRequests } from "./pg/free-prd.ts";
