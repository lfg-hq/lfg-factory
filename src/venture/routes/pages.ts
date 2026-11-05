import { Hono, type Context } from "hono";
import { VentureAnalystPage } from "../templates/landing.tsx";
import { VentureDashboardPage } from "../templates/dashboard.tsx";
import { VentureChatPage } from "../templates/chat.tsx";
import { VentureThesisPage } from "../templates/thesis.tsx";
import { VentureTermsPage } from "../templates/terms.tsx";
import { loggedRequest } from "../request-log.ts";

// Public shells only; every venture's data loads through /api/venture with
// its own sign-in and ownership checks.
const venturePages = new Hono();
venturePages.get("/venture", c => loggedRequest(c.req.raw, "venture.landing", async () => c.html(VentureAnalystPage())));
venturePages.get("/venture/terms", c => loggedRequest(c.req.raw, "venture.terms", async () => c.html(VentureTermsPage())));
venturePages.get("/venture/thesis", c => loggedRequest(c.req.raw, "venture.thesis", async () => c.html(VentureThesisPage())));
venturePages.get("/venture/chat", c => loggedRequest(c.req.raw, "venture.chat", async () => c.html(VentureChatPage())));
venturePages.get("/venture/dashboard", c => loggedRequest(c.req.raw, "venture.dashboard", async () => c.html(VentureDashboardPage())));
// The pages used to live under /venture-analyst. Signed agreements, saved chat
// messages and shared links still point there, so keep them working.
const moved = (c: Context) => { const url = new URL(c.req.url); return c.redirect(url.pathname.replace(/^\/venture-analyst/, "/venture") + url.search, 301); };
venturePages.get("/venture-analyst", moved);
venturePages.get("/venture-analyst/*", moved);
export default venturePages;
