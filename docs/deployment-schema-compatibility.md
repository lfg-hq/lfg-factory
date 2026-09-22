# Deployment schema compatibility

The deployment failure involved a locally deleted sandbox-storage-recovery module and token-usage schema definitions older than the database. Restore the missing tracked module and keep PostgreSQL/SQLite usage definitions and shared exports aligned with the existing usage tables and columns. This reconciliation preserves the production structures reported in the deployment log; it does not add the separate usage-reporting feature from another checkout.

The Docker builder now resolves local application imports before an image can reach deployment. The runtime consumes builder source to ensure that build stage executes. Startup uses safe-schema-push.ts: schema synchronization stays noninteractive, any data-loss prompt blocks startup, and a nonzero exit propagates. No destructive confirmation or force flag is supplied. This is a guard around the current Drizzle startup flow, not a replacement for reviewed production migrations.

Validated locally with module bundling, TypeScript checking, schema-retention assertions, simulated data-loss/success/failure subprocesses and sandbox recovery tests. No production database changes or deployment were performed. A production schema diff may reveal additional drift beyond the supplied log and must be reviewed rather than forced.
