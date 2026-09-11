# Ticket sandbox cloning

New CLI and API ticket build sandboxes clone the project's prepared preview when
available. The source is resolved from project_environment for the same project;
no shared checkout is edited or stashed. Magpie pauses the source during copying,
so busy or unavailable sources rejected with 404/409 use fresh provisioning.
The clone inherits disk-installed SDKs. Its copied /data/project is removed before
Git checkout so preview patches, ignored application configuration and local-only
branches do not become ticket source. Other disk files, including credentials and
copied service data, are inherited by the clone; this is not a sanitized image.
Validation continues to provision independent services and databases.

Clone intents are recorded in sandbox with workspace_type=ticket-clone before
submission. Accepted request IDs are persisted and polled every 10 seconds for up
to eleven minutes. An interrupted poll resumes that ID. Unknown submission outcomes
block automatic resubmission. Provider errors remain explicit blockers, especially
source rollback/resume failures. Ready ticket registration replaces the intent.
No source sandbox is deleted by this path. Storage-corruption recovery continues
to provision fresh, avoiding another copy of potentially broken storage.

The environment worker takes a tracked-source snapshot before the coding agent
starts. It checks that snapshot in parallel with coding. Both must finish before
publication. For a verified .NET manifest/installed SDK match, saved preview
knowledge avoids probing and installation; unknown or changed requirements fall
back to discovery. Exact-commit runtime validation still checks the finished code,
including SDK changes made during implementation, fresh schema and baseline upgrade.
Installation/build/test background commands retain 30-second polling.

This version clones the current prepared project preview directly; it does not
maintain a separate golden-image sandbox. Existing ticket sandboxes are reused.
Ticket-chat provisioning retains its existing flow. Magpie's clone endpoint and
supporting agent binary must be deployed for cloning to work. Live clone behavior
has not been exercised by local unit tests.
