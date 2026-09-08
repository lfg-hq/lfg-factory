/** Run AFTER db:push, with a DB backup. Idempotent; no external messages or token copies. */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/config/db.ts";
import { projects, projectMembers } from "../src/db/schema/projects.ts";
import { profiles, users } from "../src/db/schema/users.ts";
import { orgMemberships } from "../src/db/schema/organizations.ts";
import { personalTeam } from "../src/services/team-access.ts";

const allProjects = await db.select().from(projects);
for (const project of allProjects) {
  if (project.organizationId) continue;
  const team = await personalTeam(project.ownerId);
  const members = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, "active")));
  for (const member of members) {
    if (member.userId === team.ownerId) continue;
    await db.insert(orgMemberships).values({ userId: member.userId, organizationId: team.id, role: "member" }).onConflictDoNothing();
    // Existing subscription sharing becomes permission to use one's OWN subscription.
    await db.update(projectMembers).set({ canUsePersonalSubscription: member.canUsePersonalSubscription || member.canUseOwnerLlmSubscription, canUseOwnerLlmSubscription: false }).where(eq(projectMembers.id, member.id));
  }
  await db.update(projects).set({ organizationId: team.id }).where(and(eq(projects.id, project.id), isNull(projects.organizationId)));
}
for (const user of await db.select().from(users)) {
  const own = allProjects.find(p => p.ownerId === user.id);
  const [membership] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.status, "active"))).limit(1);
  const teamId = own ? (await personalTeam(user.id)).id : membership?.organizationId ?? (await personalTeam(user.id)).id;
  await db.insert(profiles).values({ userId: user.id, currentOrganizationId: teamId }).onConflictDoNothing();
  await db.update(profiles).set({ currentOrganizationId: teamId }).where(and(eq(profiles.userId, user.id), isNull(profiles.currentOrganizationId)));
}
console.log("Team migration complete. Projects and token ownership preserved; subscriptions remain personal.");
process.exit(0);
