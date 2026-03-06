import { Hono } from "hono";
import { LandingPage } from "../templates/pages/landing.tsx";
import { AgentPage } from "../templates/pages/agent.tsx";
import { ServicesPage } from "../templates/pages/services.tsx";
import { PortfolioPage } from "../templates/pages/portfolio.tsx";
import { BlogPage } from "../templates/pages/blog.tsx";
import { BlogPostPage } from "../templates/pages/blog-post.tsx";
import { loadBlogPosts, getBlogPostBySlug } from "../utils/blog.ts";
import { sendEmail } from "../utils/email.ts";

const landing = new Hono();

landing.get("/", (c) => {
  return c.html(LandingPage());
});

landing.get("/agent", (c) => c.redirect("/agent/"));
landing.get("/agent/", (c) => c.html(AgentPage()));

landing.get("/services", (c) => c.redirect("/services/"));
landing.get("/services/", (c) => c.html(ServicesPage()));

landing.get("/portfolio", (c) => c.redirect("/portfolio/"));
landing.get("/portfolio/", (c) => c.html(PortfolioPage()));

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
