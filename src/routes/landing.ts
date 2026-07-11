import { Hono } from "hono";
import { LandingPage } from "../templates/pages/landing.tsx";
import { AgentPage } from "../templates/pages/agent.tsx";
import { ServicesPage } from "../templates/pages/services.tsx";
import { PortfolioPage } from "../templates/pages/portfolio.tsx";
import { FactoryPage } from "../templates/pages/factory.tsx";
import { BlogPage } from "../templates/pages/blog.tsx";
import { BlogPostPage } from "../templates/pages/blog-post.tsx";
import { BuildLandingPage } from "../templates/pages/build-landing.tsx";
import { ShipLandingPage } from "../templates/pages/ship.tsx";
import { ShipV2LandingPage } from "../templates/pages/ship-v2.tsx";
import { loadBlogPosts, getBlogPostBySlug } from "../utils/blog.ts";
import { sendEmail } from "../utils/email.ts";

// In-memory store for free PRD verification codes (short-lived, no DB needed)
interface FreePrdRequest {
  id: string;
  email: string;
  projectIdea: string;
  code: string;
  expiresAt: number;
  used: boolean;
}
const freePrdStore = new Map<string, FreePrdRequest>();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanExpiredFreePrd() {
  const now = Date.now();
  for (const [id, req] of freePrdStore) {
    if (req.expiresAt < now) freePrdStore.delete(id);
  }
}

const landing = new Hono();

landing.get("/", (c) => {
  const posts = loadBlogPosts().slice(0, 3);
  return c.html(LandingPage({ posts }));
});

landing.get("/agent", (c) => c.redirect("/agent/"));
landing.get("/agent/", (c) => c.html(AgentPage()));

landing.get("/services", (c) => c.redirect("/services/"));
landing.get("/services/", (c) => c.html(ServicesPage()));

landing.get("/portfolio", (c) => c.redirect("/portfolio/"));
landing.get("/portfolio/", (c) => c.html(PortfolioPage()));

landing.get("/factory", (c) => c.redirect("/factory/"));
landing.get("/factory/", (c) => c.html(FactoryPage()));

landing.post("/api/portfolio/connect", async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, message } = body;
    if (!name || !email || !message) {
      return c.json({ error: "Name, email, and message are required." }, 400);
    }

    await sendEmail({
      to: "hello@lfg.run",
      subject: `Portfolio connect request from ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#0f172a">Portfolio connect request</h2>
        <p style="color:#475569"><strong>From:</strong> ${name} &lt;${email}&gt;</p>
        <h3 style="color:#0f172a">Message</h3>
        <p style="color:#475569;white-space:pre-wrap">${message}</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }
});

landing.get("/build", (c) => c.html(BuildLandingPage()));

// LFG Labs $999 campaign landing pages (ad-only, noindex'd in head)
landing.get("/ship", (c) => c.html(ShipLandingPage()));
landing.get("/ship/", (c) => c.redirect("/ship"));
landing.get("/ship-v2", (c) => c.html(ShipV2LandingPage()));
landing.get("/ship-v2/", (c) => c.redirect("/ship-v2"));

// LFG Labs inquiry form (used by both /ship variants)
landing.post("/api/labs/inquiry", async (c) => {
  try {
    const body = await c.req.json();
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim();
    const requirements = (body.requirements ?? "").trim();
    if (!name || !email || !requirements) {
      return c.json({ error: "Name, email, and what to build are required." }, 400);
    }

    const tier = (body.tier ?? "").trim() || "—";
    const variant = (body.variant ?? "").trim() || "—";

    const fields: Array<[string, string]> = [
      ["Name", name],
      ["Email", email],
      ["Tier", tier],
      ["Variant", variant],
    ];
    const rows = fields
      .map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;color:#334155;white-space:nowrap">${k}</td><td style="padding:6px 12px;color:#475569">${v}</td></tr>`)
      .join("");

    await sendEmail({
      to: "hello@lfg.run",
      subject: `LFG Labs lead — ${name} (${variant})`,
      text:
        fields.map(([k, v]) => `${k}: ${v}`).join("\n") +
        `\n\nWhat they want to build:\n${requirements}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#0f172a">New LFG Labs lead</h2>
        <table style="border-collapse:collapse;width:100%">${rows}</table>
        <h3 style="color:#0f172a;margin-top:20px">What they want to build</h3>
        <p style="color:#475569;white-space:pre-wrap">${requirements}</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }
});

landing.get("/blog", (c) => c.redirect("/blog/"));
landing.get("/blog/", (c) => {
  const posts = loadBlogPosts();
  return c.html(BlogPage({ posts }));
});

landing.get("/blog/:slug", (c) => c.redirect(`/blog/${c.req.param("slug")}/`));
landing.get("/blog/:slug/", (c) => {
  const { slug } = c.req.param();
  const post = getBlogPostBySlug(slug);
  if (!post) return c.notFound();

  const recentPosts = loadBlogPosts()
    .filter((p) => p.slug !== slug)
    .slice(0, 3);

  return c.html(BlogPostPage({ post, recentPosts }));
});

// Services inquiry form submission
landing.post("/api/services/inquiry", async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, requirements } = body;
    if (!name || !email || !requirements) {
      return c.json({ error: "Name, email, and requirements are required." }, 400);
    }

    const fields = [
      ["Name", name],
      ["Email", email],
      ["Company", body.company || "—"],
      ["Role", body.role || "—"],
      ["Timeline", body.timeline || "—"],
      ["Budget", body.budget || "—"],
    ];

    const rows = fields.map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;color:#334155;white-space:nowrap">${k}</td><td style="padding:6px 12px;color:#475569">${v}</td></tr>`).join("");

    await sendEmail({
      to: "hello@lfg.run",
      subject: `New services inquiry from ${name}`,
      text: fields.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nRequirements:\n${requirements}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#0f172a">New services inquiry</h2>
        <table style="border-collapse:collapse;width:100%">${rows}</table>
        <h3 style="color:#0f172a;margin-top:20px">Requirements</h3>
        <p style="color:#475569;white-space:pre-wrap">${requirements}</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }
});

// Factory pilot request (IT services firms)
landing.post("/api/factory/pilot", async (c) => {
  try {
    const body = await c.req.json();
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim();
    const project = (body.project ?? "").trim();
    if (!name || !email || !project) {
      return c.json({ error: "Name, work email, and the project description are required." }, 400);
    }

    // Keep the pilot pipeline clean: require a business email
    const FREE_EMAIL_DOMAINS = new Set([
      "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "hotmail.com",
      "outlook.com", "live.com", "aol.com", "icloud.com", "me.com", "proton.me",
      "protonmail.com", "mail.com", "gmx.com", "yandex.com", "rediffmail.com",
    ]);
    const domain = email.split("@")[1]?.toLowerCase().trim();
    if (!domain || FREE_EMAIL_DOMAINS.has(domain)) {
      return c.json({ error: "Please use your work email address, not a personal one." }, 400);
    }

    const fields = [
      ["Name", name],
      ["Work email", email],
      ["Firm", body.firm || "—"],
      ["Headcount", body.headcount || "—"],
      ["Role", body.role || "—"],
    ];

    const rows = fields.map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;color:#334155;white-space:nowrap">${k}</td><td style="padding:6px 12px;color:#475569">${v}</td></tr>`).join("");

    await sendEmail({
      to: "hello@lfg.run",
      subject: `[FACTORY PILOT] ${name}${body.firm ? ` — ${body.firm}` : ""}`,
      text: fields.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nProject to test:\n${project}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#0f172a">New factory pilot request</h2>
        <table style="border-collapse:collapse;width:100%">${rows}</table>
        <h3 style="color:#0f172a;margin-top:20px">Project to test</h3>
        <p style="color:#475569;white-space:pre-wrap">${project}</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }
});

// Free PRD — request verification code
landing.post("/api/free-prd/request-code", async (c) => {
  try {
    const body = await c.req.json();
    const email = (body.email ?? "").trim().toLowerCase();
    const projectIdea = (body.project_idea ?? "").trim();
    if (!email || !projectIdea) {
      return c.json({ error: "Email and project idea are required." }, 400);
    }

    cleanExpiredFreePrd();
    const id = crypto.randomUUID();
    const code = generateCode();
    freePrdStore.set(id, { id, email, projectIdea, code, expiresAt: Date.now() + 30 * 60 * 1000, used: false });

    await sendEmail({
      to: email,
      subject: "Your LFG free PRD verification code",
      text: `Your verification code is: ${code}\n\nThis code expires in 30 minutes.`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#0f172a">Your verification code</h2>
        <p style="font-size:2rem;font-weight:700;letter-spacing:0.2em;color:#4f46e5">${code}</p>
        <p style="color:#64748b">This code expires in 30 minutes.</p>
      </div>`,
    });

    return c.json({ success: true, request_id: id });
  } catch {
    return c.json({ error: "Unable to send verification code right now." }, 500);
  }
});

// Free PRD — verify code
landing.post("/api/free-prd/verify-code", async (c) => {
  try {
    const body = await c.req.json();
    const requestId = (body.request_id ?? "").trim();
    const code = String(body.code ?? "").trim();

    if (!requestId || !code) return c.json({ error: "Request ID and code are required." }, 400);

    const record = freePrdStore.get(requestId);
    if (!record) return c.json({ error: "Request not found." }, 404);
    if (record.used) return c.json({ success: true, already_verified: true });
    if (Date.now() > record.expiresAt) return c.json({ error: "Code has expired." }, 400);
    if (record.code !== code) return c.json({ error: "Invalid code." }, 400);

    record.used = true;

    // Notify the team
    await sendEmail({
      to: "hello@lfg.run",
      subject: `Free PRD request from ${record.email}`,
      text: `From: ${record.email}\n\nProject idea:\n${record.projectIdea}`,
      html: `<div style="font-family:sans-serif;max-width:600px">
        <h2 style="color:#0f172a">New Free PRD request</h2>
        <p style="color:#475569"><strong>Email:</strong> ${record.email}</p>
        <h3 style="color:#0f172a">Project idea</h3>
        <p style="color:#475569;white-space:pre-wrap">${record.projectIdea}</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Verification failed." }, 500);
  }
});

// Free PRD — resend code
landing.post("/api/free-prd/resend-code", async (c) => {
  try {
    const body = await c.req.json();
    const requestId = (body.request_id ?? "").trim();
    if (!requestId) return c.json({ error: "Request ID is required." }, 400);

    const record = freePrdStore.get(requestId);
    if (!record) return c.json({ error: "Request not found." }, 404);
    if (record.used) return c.json({ success: true, already_verified: true });

    record.code = generateCode();
    record.expiresAt = Date.now() + 30 * 60 * 1000;

    await sendEmail({
      to: record.email,
      subject: "Your new LFG free PRD verification code",
      text: `Your new verification code is: ${record.code}\n\nThis code expires in 30 minutes.`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#0f172a">Your new verification code</h2>
        <p style="font-size:2rem;font-weight:700;letter-spacing:0.2em;color:#4f46e5">${record.code}</p>
        <p style="color:#64748b">This code expires in 30 minutes.</p>
      </div>`,
    });

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Unable to resend code right now." }, 500);
  }
});

// Blog "Ask LFG" CTA submission
landing.post("/api/blog/ask", async (c) => {
  try {
    const body = await c.req.json();
    const { email, message } = body;
    if (!email || !message) {
      return c.json({ error: "Email and message are required." }, 400);
    }

    await Promise.all([
      // Notify the team
      sendEmail({
        to: "hello@lfg.run",
        subject: `Blog CTA: workflow automation inquiry from ${email}`,
        text: `From: ${email}\n\n${message}`,
        html: `<div style="font-family:sans-serif;max-width:600px">
          <h2 style="color:#0f172a">Blog CTA inquiry</h2>
          <p style="color:#475569"><strong>From:</strong> ${email}</p>
          <h3 style="color:#0f172a">Message</h3>
          <p style="color:#475569;white-space:pre-wrap">${message}</p>
        </div>`,
      }),
      // Ack to the sender
      sendEmail({
        to: email,
        subject: "We got your message — LFG",
        text: `Hey,\n\nThanks for reaching out. We'll review your workflow and get back to you shortly.\n\nYour message:\n${message}\n\n— Team LFG`,
        html: `<div style="font-family:sans-serif;max-width:600px;color:#334155">
          <h2 style="color:#0f172a">We got your message</h2>
          <p>Thanks for reaching out. We'll review your workflow and get back to you shortly.</p>
          <blockquote style="border-left:3px solid #6366f1;margin:16px 0;padding:8px 16px;background:#f8fafc;border-radius:0 8px 8px 0;color:#475569">
            ${message}
          </blockquote>
          <p>— Team LFG</p>
        </div>`,
      }),
    ]);

    return c.json({ success: true });
  } catch {
    return c.json({ error: "Invalid request." }, 400);
  }
});

export default landing;
