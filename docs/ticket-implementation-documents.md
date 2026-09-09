# Ticket implementation documents

Successful ticket publication now maintains one tracked Markdown document under the application's `docs/` directory. The path is the hyphenated branch name plus a short stable hash, avoiding collisions between names such as `feature/a` and `feature-a`. Ticket renames do not move the document.

Each new source tree appends a dated entry with a concise summary, implementation details, validation evidence, rollout/configuration requirements, and limitations. Existing entries and manual edits are preserved; unchanged source trees do not create duplicate entries. The first heading uses the ticket title. The description is generated from the ticket, changes since the last documented revision (or the baseline on the first run), prior notes, and server-recorded validation stages. Truncated or missing evidence must not be presented as verified facts.

The shared ticket publication path covers both builders, rebuilds, ticket chat edits, recovery, manual commits, and QA changes. Documentation is written after source validation, committed, then the final commit is validated before publication. A failure at that final gate cannot publish the earlier passing commit. The normal ticket-to-epic merge carries the document with the code. Existing already-built branches receive their document on their next successful update; no historical backfill is performed.

Completion Agent messages include the short description and a repository link to the same document. Detailed prose lives in the document instead of expanding the completion bubble. The generator uses the acting user's configured model and fails explicitly if it cannot produce a valid document. No extra database migration is introduced by this feature.

Writes are atomic and refuse symlinked destinations or a document changed during generation. Tests cover stable/collision-safe filenames, history preservation, unchanged-tree deduplication, containment, concurrent edit rejection, repository links, and final-commit validation before push.
