# Database startup safeguards

Deterministic database startup never deletes database files, removes a database
container, or kills a process occupying its port to recover from an error.
Preview setup now passes startup failures to a separate, bounded AI recovery
stage, then verifies the database again before accepting success.

The shared PostgreSQL, MySQL, Redis, and SQL Server startup script now:

- Checks every container, including stopped/restarting containers, for the same
  published host port or database directory. Conflicts enter the recovery stage.
- Verifies an existing managed container mounts the expected data directory.
- Preserves Docker start/create errors (including native port conflicts) and stops
  immediately rather than polling a container that never started.
- Checks the container state while waiting for readiness. Access checks run only
  after readiness succeeds. PostgreSQL verifies credentials over TCP.
- Reports access failures without inferring that existing data is disposable.
- Uses a per-directory startup lock. An unresolved lock blocks another startup;
  recovery must verify that its previous process exited before removing it.
- Uses unique script/log files per attempt so concurrent requests cannot overwrite
  each other's progress. Scripts/logs are private to the sandbox user, and the
  managed password is redacted from surfaced bring-up errors.

New databases still initialize normally through their official container image.
This does not restore missing files or repair filesystem corruption. Explicit
database-reset/recovery tools are separate from ordinary startup and retain their
own authorization and backup requirements.

The AI inspects the actual error, container ownership, existing data and backups.
It prefers reconnecting or restoring existing data. If recovery is unavailable,
it may create a fresh development database after quarantining existing files,
and must explicitly report that old records were not restored. It preserves
container configuration before retiring obsolete conflicting containers. It
cannot replace VMs or repair provider disks. Unresolved ownership failures stop
recovery. Repairs get at most two attempts, with cancellation and time limits.

After repair, deterministic startup verifies authenticated connectivity. Preview
setup persists the managed connection encrypted in project environment settings,
writes .env and continues through migrations and application checks. Shared
development instructions also reach the preview driver, builder and ticket/Pi
runtime agents; isolated ticket agents cannot alter the shared preview settings.

Calendar was manually restored from its retained SQL recovery dump on September
26. Table counts matched the dump before switching the restored database into
service. Backups and old container configurations remain under
/data/lfg-recovery/manual-20260926-165933. This manual recovery is separate from
deploying the new recovery code.

Regression tests execute the generated shell script against a simulated Docker
command and real temporary data files. They verify data survives conflicts,
failed starts, authentication failures, readiness timeouts, and stale locks, and
that successful new/existing container startup remains possible.
