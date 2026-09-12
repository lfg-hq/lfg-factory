# Preview patch and database recovery

LFG's preview recovery agent can inspect and replace the entire branch-scoped
saved patch recipe. Replacement requires dry-run success on both the current files
and a new detached checkout of the current commit (including normal default-branch
connection rewriting). Obsolete patches can be retired explicitly with a reason;
unrelated patches must be retained. Chained patches for the same file are rejected:
the agent must consolidate them. Deletions must include stable surrounding context
so their already-applied state can be verified. Full clean replay still decides
whether preview succeeds. Configuration failure instructions prioritize patch
reconciliation before unrelated database work. updatePlan's patch path uses the
same verification gate.

The recovery agent now has resetDevelopmentDatabase for managed local SQL Server.
It validates the selected .env connection against the provisioned engine credentials,
port, user and database. External connections, system databases and unsupported
engines are blocked. It creates a COPY_ONLY full backup (schema and data), runs
RESTORE VERIFYONLY WITH CHECKSUM, copies the backup out of the container and compares
its SHA-256 with the native backup. Original tracked source is archived with git
archive HEAD. Both files have a saved checksum manifest. A backup record is persisted
in the branch app profile before any reset. Re-probing preserves these records.

Artifacts are retained at /data/lfg-recovery/<uuid>/database.bak, source.tar and
SHA256SUMS in that sandbox; SQL Server also retains the native .bak. The profile
records workspace ID, database, connection key, path, timestamp and reason (no
password). These files survive database resets, but are not exported off the VM:
operators must export them before destroying the sandbox. Restoring is an explicit
operator action using the native SQL Server backup; reset failures do not trigger
an automatic restore that could overwrite further work.

At most one agent-requested reset per database is allowed in a recovery attempt.
The original backup is verified again before resetting, and checksums are rechecked.
If the driver succeeds after reset, the executor resets that same database once
more against the retained original backup and qualifies the corrected recipe from
an empty database and clean checkout. This catches fixes that only work after an
earlier partially successful seed. SQL script corrections are saved as preview
patches and ordered executable schemaSteps, rather than only advisory notes.
Preview recovery never commits, pushes or merges source code.

Direct DROP DATABASE/dropdb commands in the recovery run tool are redirected to
the guarded tool. This is a workflow guard, not a security boundary around the
agent's existing shell access. PostgreSQL/MySQL/SQLite backup-and-reset adapters
are not implemented by this change; agents must report a reset blocker for them.
Existing schema diagnosis and repair remains available without destructive reset.
No CoHire repository files were edited by this implementation.

Validation: local tests execute generated patch scripts and connection guards,
exercise backup failure/recording failure/reset ordering, and run existing preview
and runtime regression tests. A live Magpie/SQL Server backup/reset/replay has not
been run locally. No production reset or deployment was performed.
