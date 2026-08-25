import { Hono } from "hono";
import { LandingPage } from "../templates/pages/landing.tsx";
import { AgentPage } from "../templates/pages/agent.tsx";
import { SelfHostPage } from "../templates/pages/self-host.tsx";
import { ServicesPage } from "../templates/pages/services.tsx";
import { ProofPage } from "../templates/pages/proof.tsx";
import { VsCodingAgentsPage } from "../templates/pages/vs-coding-agents.tsx";
import { BlogPage } from "../templates/pages/blog.tsx";
import { BlogPostPage } from "../templates/pages/blog-post.tsx";
import { BuildLandingPage } from "../templates/pages/build-landing.tsx";
import { ShipLandingPage } from "../templates/pages/ship.tsx";
import { ShipV2LandingPage } from "../templates/pages/ship-v2.tsx";
import { loadBlogPosts, getBlogPostBySlug } from "../utils/blog.ts";
import { sendEmail } from "../utils/email.ts";
import { db } from "../config/db.ts";
import { freePrdRequests } from "../db/schema/free-prd.ts";
import { eq } from "drizzle-orm";
import { env } from "../config/env.ts";
import { FreePrdPage } from "../templates/pages/free-prd.tsx";
import { AppsPage } from "../templates/pages/apps.tsx";
import { processFreePrdRequest } from "../services/free-prd.ts";
import { LegalPage } from "../templates/pages/legal.tsx";
import { optionalAuth } from "../auth/middleware.ts";

const CODE_TTL_MS = 30 * 60 * 1000;
const BLUEPRINT_RATE_WINDOW_MS = 60 * 60 * 1000;
const BLUEPRINT_RATE_LIMIT = 5;
const blueprintAttempts = new Map<string, { count: number; resetsAt: number }>();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isBlueprintRateLimited(key: string) {
  const now = Date.now();
  const current = blueprintAttempts.get(key);
  if (!current || current.resetsAt <= now) {
    blueprintAttempts.set(key, { count: 1, resetsAt: now + BLUEPRINT_RATE_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > BLUEPRINT_RATE_LIMIT;
}

function initialLeadScore(details: Record<string, string>, projectIdea: string) {
  const budgetPoints: Record<string, number> = {
    "CAD $999–$2,500": 15,
    "CAD $2,500–$5,000": 20,
    "CAD $5,000–$15,000": 25,
    "CAD $15,000+": 25,
    "Not sure yet": 5,
  };
  const timelinePoints: Record<string, number> = {
    Immediately: 25,
    "Within 30 days": 20,
    "Within three months": 10,
    "Researching for later": 2,
  };
  const clarity = projectIdea.length >= 150 ? 20 : projectIdea.length >= 70 ? 12 : 5;
  const namedUsers = details.audience ? 10 : 0;
  const existingProcess = details.current_workflow && details.current_workflow !== "We have not started yet" ? 10 : 0;
  return Math.min(85, (budgetPoints[details.budget || ""] || 0) + (timelinePoints[details.timeline || ""] || 0) + clarity + namedUsers + existingProcess);
}

// Verify a Cloudflare Turnstile token. If no secret is configured, don't block.
async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[turnstile] free-prd verify error:", err);
    return false;
  }
}

const landing = new Hono();

landing.get("/", (c) => {
  const posts = loadBlogPosts().slice(0, 3);
  return c.html(LandingPage({ posts, turnstileSiteKey: env.TURNSTILE_SITE_KEY }));
});

// Instant Apps landing — describe an app, verify email (or Google), build on /instant.
// optionalAuth lets an already-logged-in visitor skip verification.
landing.get("/apps", optionalAuth, (c) => {
  const user = (c as any).get("user");
  return c.html(
    AppsPage({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      isAuthenticated: !!user,
    })
  );
});
landing.get("/apps/", (c) => c.redirect("/apps"));

landing.get("/agent", (c) => c.redirect("/agent/"));
landing.get("/agent/", (c) => c.html(AgentPage()));

landing.get("/self-host", (c) => c.redirect("/self-host/"));
landing.get("/self-host/", (c) => c.html(SelfHostPage()));

landing.get("/services", (c) => c.redirect("/services/"));
landing.get("/services/", (c) => c.html(ServicesPage()));

landing.get("/proof", (c) => c.redirect("/proof/"));
landing.get("/proof/", (c) => c.html(ProofPage()));

// Positioning page: "why LFG if we already use Claude Code / Codex?"
landing.get("/vs-coding-agents", (c) => c.redirect("/vs-coding-agents/"));
landing.get("/vs-coding-agents/", (c) => c.html(VsCodingAgentsPage()));
landing.get("/why-lfg", (c) => c.redirect("/vs-coding-agents/", 301));
landing.get("/why-lfg/", (c) => c.redirect("/vs-coding-agents/", 301));

// The factory pitch is now the homepage; /portfolio became /proof.
landing.get("/factory", (c) => c.redirect("/", 301));
landing.get("/factory/", (c) => c.redirect("/", 301));
landing.get("/portfolio", (c) => c.redirect("/proof/", 301));
landing.get("/portfolio/", (c) => c.redirect("/proof/", 301));

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

landing.get("/build", (c) => c.redirect("/build-sprint", 301));
landing.get("/build-sprint", (c) => c.html(BuildLandingPage({ turnstileSiteKey: env.TURNSTILE_SITE_KEY })));
landing.get("/build-sprint/", (c) => c.redirect("/build-sprint"));
landing.get("/999-build-sprint", (c) => c.redirect("/build-sprint", 301));
landing.get("/privacy", (c) => c.redirect("/privacy/"));
landing.get("/privacy/", (c) => c.html(LegalPage({ type: "privacy" })));
landing.get("/terms", (c) => c.redirect("/terms/"));
landing.get("/terms/", (c) => c.html(LegalPage({ type: "terms" })));

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

function codeEmail(to: string, code: string, isResend = false) {
  return {
    to,
    subject: isResend ? "Your new LFG Build Blueprint verification code" : "Your LFG Build Blueprint verification code",
    text: `Your${isResend ? " new" : ""} verification code is: ${code}\n\nThis code expires in 30 minutes.`,
    html: `<div style="font-family:sans-serif;max-width:480px">
      <h2 style="color:#0f172a">Your${isResend ? " new" : ""} verification code</h2>
      <p style="font-size:2rem;font-weight:700;letter-spacing:0.2em;color:#4f46e5">${code}</p>
      <p style="color:#64748b">This code expires in 30 minutes.</p>
    </div>`,
  };
}

// Free PRD — request verification code (gated by Turnstile bot check)
landing.post("/api/free-prd/request-code", async (c) => {
  try {
    const body = await c.req.json();
    const email = (body.email ?? "").trim().toLowerCase();
    const projectIdea = (body.project_idea ?? "").trim();
    const turnstileToken = (body.turnstile_token ?? "").trim();
    const campaign = (body.campaign ?? "").trim();
    const rawDetails = body.details && typeof body.details === "object" ? body.details : {};
    const details = Object.fromEntries(
      Object.entries(rawDetails).map(([key, value]) => [key, String(value ?? "").trim().slice(0, 1000)])
    ) as Record<string, string>;
    if (!email || !projectIdea) {
      return c.json({ error: "Email and project idea are required." }, 400);
    }
    if (projectIdea.length < 12) {
      return c.json({ error: "Please describe what you want to build in a bit more detail." }, 400);
    }

    if (campaign === "build-sprint" && (!details.name || !details.company || !details.audience || !details.current_workflow || !details.timeline || !details.budget)) {
      return c.json({ error: "Please complete all required Build Blueprint fields." }, 400);
    }

    const ip = (c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown").split(",")[0]?.trim();
    if (isBlueprintRateLimited(`ip:${ip}`) || isBlueprintRateLimited(`email:${email}`)) {
      return c.json({ error: "Too many blueprint requests. Please wait an hour and try again." }, 429);
    }
    if (!(await verifyTurnstile(turnstileToken, ip))) {
      return c.json({ error: "Please complete the bot check and try again." }, 403);
    }

    const code = generateCode();
    const leadScore = campaign === "build-sprint" ? initialLeadScore(details, projectIdea) : 0;
    const attribution = {
      utm_source: details.utm_source || "",
      utm_medium: details.utm_medium || "",
      utm_campaign: details.utm_campaign || "",
      utm_content: details.utm_content || "",
      utm_term: details.utm_term || "",
      referrer: details.referrer || "",
      landing_variant: details.landing_variant || "",
      user_agent: c.req.header("user-agent") || "",
    };
    const [record] = await db
      .insert(freePrdRequests)
      .values({
        email,
        projectIdea,
        campaign: campaign || null,
        name: details.name || null,
        company: details.company || null,
        website: details.website || null,
        audience: details.audience || null,
        currentWorkflow: details.current_workflow || null,
        integration: details.integration || null,
        timeline: details.timeline || null,
        budget: details.budget || null,
        attributionJson: JSON.stringify(attribution),
        consentAt: campaign === "build-sprint" ? new Date() : null,
        leadScore,
        priority: leadScore >= 60 ? "high" : "normal",
        blueprintVersion: campaign === "build-sprint" ? "1" : null,
        modelVersion: campaign === "build-sprint" ? "deepseek-chat" : null,
        promptVersion: campaign === "build-sprint" ? "build-blueprint-v1" : null,
        code,
        codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
        status: "pending_verification",
      })
      .returning();

    await sendEmail(codeEmail(email, code));

    return c.json({ success: true, request_id: record!.id });
  } catch (err) {
    console.error("[free-prd] request-code error:", err);
    return c.json({ error: "Unable to send verification code right now." }, 500);
  }
});

// Free PRD — verify code, then kick off assessment + PRD generation
landing.post("/api/free-prd/verify-code", async (c) => {
  try {
    const body = await c.req.json();
    const requestId = (body.request_id ?? "").trim();
    const code = String(body.code ?? "").trim();
    if (!requestId || !code) return c.json({ error: "Request ID and code are required." }, 400);

    const [record] = await db.select().from(freePrdRequests).where(eq(freePrdRequests.id, requestId));
    if (!record) return c.json({ error: "Request not found." }, 404);
    if (record.verified) return c.json({ success: true, already_verified: true, prd_url: `/prd/${requestId}` });
    if (!record.codeExpiresAt || Date.now() > new Date(record.codeExpiresAt).getTime()) {
      return c.json({ error: "Code has expired. Please resend." }, 400);
    }
    if (record.code !== code) return c.json({ error: "Invalid code." }, 400);

    await db
      .update(freePrdRequests)
      .set({ verified: true, code: null, status: "assessing", updatedAt: new Date() })
      .where(eq(freePrdRequests.id, requestId));

    // Run the requirements check + PRD generation in the background.
    void processFreePrdRequest(requestId);

    return c.json({ success: true, prd_url: `/prd/${requestId}` });
  } catch (err) {
    console.error("[free-prd] verify-code error:", err);
    return c.json({ error: "Verification failed." }, 500);
  }
});

// Free PRD — resend code
landing.post("/api/free-prd/resend-code", async (c) => {
  try {
    const body = await c.req.json();
    const requestId = (body.request_id ?? "").trim();
    if (!requestId) return c.json({ error: "Request ID is required." }, 400);

    const [record] = await db.select().from(freePrdRequests).where(eq(freePrdRequests.id, requestId));
    if (!record) return c.json({ error: "Request not found." }, 404);
    if (record.verified) return c.json({ success: true, already_verified: true });

    const code = generateCode();
    await db
      .update(freePrdRequests)
      .set({ code, codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), updatedAt: new Date() })
      .where(eq(freePrdRequests.id, requestId));

    await sendEmail(codeEmail(record.email, code, true));
    return c.json({ success: true });
  } catch (err) {
    console.error("[free-prd] resend-code error:", err);
    return c.json({ error: "Unable to resend code right now." }, 500);
  }
});

// Free PRD — status poll for the /prd/:id page while generating
landing.get("/api/free-prd/:id/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const id = c.req.param("id");
  const [record] = await db.select().from(freePrdRequests).where(eq(freePrdRequests.id, id));
  if (!record || !record.verified) return c.json({ error: "Not found" }, 404);
  return c.json({ status: record.status });
});

// Free PRD — submit clarification answers OR request a modification, then regenerate
landing.post("/api/free-prd/:id/refine", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const answers = (body.answers ?? "").trim();
    if (!answers) return c.json({ error: "Please add some details." }, 400);

    const [record] = await db.select().from(freePrdRequests).where(eq(freePrdRequests.id, id));
    if (!record) return c.json({ error: "Request not found." }, 404);
    if (!record.verified) return c.json({ error: "This request is not verified." }, 403);

    const merged = record.clarificationAnswers ? `${record.clarificationAnswers}\n\n${answers}` : answers;
    await db
      .update(freePrdRequests)
      .set({ clarificationAnswers: merged, status: "assessing", updatedAt: new Date() })
      .where(eq(freePrdRequests.id, id));

    void processFreePrdRequest(id);
    return c.json({ success: true });
  } catch (err) {
    console.error("[free-prd] refine error:", err);
    return c.json({ error: "Unable to submit right now." }, 500);
  }
});

// Free PRD — public page (PRD view / clarification form / progress)
landing.get("/prd/:id", async (c) => {
  // Never let the browser serve a stale PRD page — status/content changes over time.
  c.header("Cache-Control", "no-store, must-revalidate");
  const id = c.req.param("id");
  const [record] = await db.select().from(freePrdRequests).where(eq(freePrdRequests.id, id));
  if (!record || !record.verified) {
    return c.html(FreePrdPage({ notFound: true }), 404);
  }

  try {
    await db
      .update(freePrdRequests)
      .set({ viewCount: (record.viewCount ?? 0) + 1 })
      .where(eq(freePrdRequests.id, id));
  } catch {
    /* view count is best-effort */
  }

  let questions: string[] = [];
  if (record.clarifyingQuestions) {
    try {
      questions = JSON.parse(record.clarifyingQuestions);
    } catch {
      questions = [];
    }
  }

  return c.html(
    FreePrdPage({
      id: record.id,
      email: record.email,
      status: record.status,
      title: record.title,
      projectIdea: record.projectIdea,
      prdMarkdown: record.prdMarkdown,
      qualification: record.qualification,
      questions,
    })
  );
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
