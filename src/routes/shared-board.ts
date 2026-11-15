/**
 * GET /board/:token: a whiteboard opened by its link, with no account needed.
 * Someone who happens to be signed in is shown under their own name; everyone else is asked for one.
 */
import { Hono } from "hono";
import { optionalAuth } from "../auth/middleware.ts";
import { boardByShareToken, shareModeOf } from "../services/whiteboards/store.ts";
import { WhiteboardPage } from "../templates/pages/whiteboard.tsx";
import { getProjectAccess } from "../auth/project-access.ts";
import type { auth } from "../auth/index.ts";

const sharedBoardRoutes = new Hono<{ Variables: { user: typeof auth.$Infer.Session.user | null } }>();

sharedBoardRoutes.get("/board/:token", optionalAuth, async (c) => {
  const token = c.req.param("token");
  const board = await boardByShareToken(token);
  if (!board) return c.text("This board link is not available. Ask whoever sent it for a new one.", 404);
  // A member of the board's project gets the full board (project menu, Ask LFG), not the guest view.
  const user = c.get("user");
  if (user && board.projectId && await getProjectAccess(board.projectId, user.id)) {
    return c.redirect(`/projects/${encodeURIComponent(board.projectId)}/whiteboards/${encodeURIComponent(board.id)}`);
  }
  // The link is a secret: keep it out of Referer headers and search engines.
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  return c.html(WhiteboardPage({
    board: { id: board.id, title: board.title }, user: { name: c.get("user")?.name ?? "" },
    canEdit: shareModeOf(board) === "edit", canChat: false, shareToken: token,
  }));
});

export default sharedBoardRoutes;
