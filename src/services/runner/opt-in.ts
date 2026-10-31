/**
 * "Build on my computer" is opt-in per person (Settings → Integrations → Computers).
 * Off: the ticket Run menu doesn't offer it and the server refuses local builds.
 */

import { eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { profiles } from "../../db/schema/users.ts";

export async function desktopBuildsEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: profiles.desktopBuildsEnabled }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row?.enabled ?? false;
}

export async function setDesktopBuildsEnabled(userId: string, enabled: boolean): Promise<void> {
  await db.insert(profiles).values({ userId, desktopBuildsEnabled: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({ target: profiles.userId, set: { desktopBuildsEnabled: enabled, updatedAt: new Date() } });
}
