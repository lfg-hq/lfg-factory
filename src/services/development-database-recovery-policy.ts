/** Shared by preview recovery and Pi development/runtime prompts. */
export const DEVELOPMENT_DATABASE_RECOVERY_INSTRUCTION = `Development database recovery is part of your job. Diagnose the actual error and repair the local development database autonomously; do not send nontechnical users Docker commands or stop merely because a database is missing.
- First inspect Docker state/error, container logs, mounts, port owners, disk health, the app's connection configuration, existing database files, and recovery backups. A stopped container, occupied port, or readiness timeout is not proof of bad credentials.
- Prefer restoring a usable backup or reconnecting the existing database. Verify the restored schema and row counts where a dump provides them. Never infer success from files existing or a container merely being running.
- You may start services, repair credentials, create a new local database, run checked-in migrations/seeds, and update development environment variables. If no usable recovery exists, you are authorized to create a fresh development database without asking the user. Preserve the old files in a dated recovery directory first; report explicitly that prior records were not restored. Do not claim a fresh database is a data restoration.
- Resolve local container/port conflicts based on ownership and mounts. Preserve container configuration and database files before retiring an obsolete local database container. Do not kill an unidentified process, delete backups, or let two engines write the same data directory. Do not recreate the VM, change host disk ownership, run filesystem repair on a mounted disk, or touch an external/production database. Escalate provider-level disk/VM faults with evidence.
- Store passwords securely; never print or commit them. Update .env and the project's durable environment settings when a persistence tool is available. Ticket agents must keep changes scoped to their assigned development sandbox; do not overwrite the shared preview's environment from an isolated ticket sandbox. Use the configured local credentials when available so restarts keep working.
- Verify authenticated connectivity, required schema/migrations, and an application request that exercises the database. Retry only after a concrete change, and give short progress updates in plain language. Record what was repaired, any backup location, any fresh-database fallback, and verification evidence. Do not commit or push recovery changes yourself.`;

export async function withDatabaseRecovery<T>(o: {
  ensure: () => Promise<T>;
  repair: (error: string, attempt: number) => Promise<void>;
  progress: (message: string) => void;
  cancelled?: () => boolean;
}): Promise<T> {
  let last = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (o.cancelled?.()) throw new Error('__CANCELLED__');
    try { return await o.ensure(); }
    catch (e) {
      if (o.cancelled?.()) throw new Error('__CANCELLED__');
      last = e instanceof Error ? e.message : String(e);
      if (/__CANCELLED__|Multiple active sandbox jobs|disk ownership|released.*disk|creation is unresolved|Automatic replacement is blocked/i.test(last)) throw e;
      if (attempt === 2) break;
      o.progress(attempt ? 'The database still needs repair. Checking the remaining problem…' : 'The database needs repair. Checking existing data and backups…');
      await o.repair(last, attempt + 1);
    }
  }
  throw new Error(`Automatic database recovery could not verify a working database after two repair attempts. Existing backups were retained. Last check: ${last}`);
}
