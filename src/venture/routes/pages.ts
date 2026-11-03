import { Hono } from "hono";
import { VentureAnalystPage } from "../templates/landing.tsx";
import { VentureDashboardPage } from "../templates/dashboard.tsx";
import { VentureChatPage } from "../templates/chat.tsx";
import { VentureThesisPage } from "../templates/thesis.tsx";
import { loggedRequest } from "../request-log.ts";

// Public shells only; every venture's data loads through /api/venture with
// its own sign-in and ownership checks.
const venturePages = new Hono();
venturePages.get("/venture-analyst", c => loggedRequest(c.req.raw, "venture.landing", async () => c.html(VentureAnalystPage())));
venturePages.get("/venture-analyst/thesis", c => loggedRequest(c.req.raw, "venture.thesis", async () => c.html(VentureThesisPage())));
venturePages.get("/venture-analyst/chat", c => loggedRequest(c.req.raw, "venture.chat", async () => c.html(VentureChatPage())));
venturePages.get("/venture-analyst/dashboard", c => loggedRequest(c.req.raw, "venture.dashboard", async () => c.html(VentureDashboardPage())));
export default venturePages;
