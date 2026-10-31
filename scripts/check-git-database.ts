// Read-only runtime prerequisite check. Uses the same .env/dialect/schema as the web process.
import { db } from '../src/config/db.ts';
import { projects } from '../src/db/schema/projects.ts';
import { epics } from '../src/db/schema/epics.ts';
import { projectTickets } from '../src/db/schema/tickets.ts';
import { ticketExecutions } from '../src/db/schema/orchestrator.ts';
import { gitMutations } from '../src/db/schema/git-mutations.ts';
import { projectEnvironments } from '../src/db/schema/project-environments.ts';
import { runtimeValidations } from '../src/db/schema/runtime-validation.ts';
import { sandboxes } from '../src/db/schema/sandbox.ts';
import { gitReviews, gitOperations } from '../src/db/schema/git-reviews.ts';
import { githubTokens, gitlabTokens } from '../src/db/schema/users.ts';
try {
  for (const table of [projects, epics, projectTickets, ticketExecutions, githubTokens, gitlabTokens, gitReviews, gitOperations, gitMutations, projectEnvironments, runtimeValidations, sandboxes]) await db.select().from(table).limit(0);
  console.log('Git database connectivity and required schema OK (read-only).');
  process.exit(0);
} catch {
  console.error('Git database prerequisite failed. Check the selected local database service and schema.');
  process.exit(1);
}
