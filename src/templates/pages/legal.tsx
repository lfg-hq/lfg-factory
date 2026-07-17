import { html } from "hono/html";

export function LegalPage({ type }: { type: "privacy" | "terms" }) {
  const privacy = type === "privacy";
  const title = privacy ? "Privacy Policy" : "Terms of Use";
  return html`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — LFG</title><meta name="robots" content="index,follow"><link rel="icon" href="/public/images/favicon.ico"><style>
  :root{font-family:system-ui,sans-serif;color:#182230;background:#f8fafc}*{box-sizing:border-box}body{margin:0}.wrap{width:min(760px,calc(100% - 32px));margin:0 auto;padding:42px 0 80px}.brand{display:flex;align-items:center;gap:9px;color:#101828;text-decoration:none;font-weight:800;margin-bottom:54px}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#5b5ce2;color:white}article{background:white;border:1px solid #e4e7ec;border-radius:16px;padding:clamp(24px,6vw,52px)}h1{font-size:clamp(34px,6vw,48px);letter-spacing:-.04em;margin:0 0 8px}h2{font-size:20px;margin:32px 0 8px}p,li{color:#475467;line-height:1.7}small{color:#667085}a{color:#494ac8}
  </style></head><body><div class="wrap"><a class="brand" href="/"><span class="mark">L</span>LFG</a><article><h1>${title}</h1><small>Last updated July 13, 2026</small>
  ${privacy ? html`
    <h2>Information we collect</h2><p>When you request a Build Blueprint or contact LFG, we collect the information you provide, such as your name, work email, company, website and project description. We may also collect basic attribution and device information needed to understand how the service is used and protect it from abuse.</p>
    <h2>How we use information</h2><p>We use this information to prepare and deliver your blueprint, assess whether a project fits the Build Sprint, respond to your request, improve the service, prevent misuse and meet legal obligations.</p>
    <h2>AI processing</h2><p>Project descriptions may be processed by selected AI service providers to generate the requested blueprint. Do not submit passwords, credentials, regulated data or other sensitive personal information.</p>
    <h2>Sharing and retention</h2><p>We share information only with providers needed to operate the service, such as infrastructure, email and AI processing partners. We retain it only as long as reasonably needed for the purposes above or as required by law.</p>
    <h2>Your choices</h2><p>You may request access, correction or deletion of your information by emailing <a href="mailto:hello@lfg.run">hello@lfg.run</a>.</p>
  ` : html`
    <h2>Using the service</h2><p>You may use the LFG website and Build Blueprint flow for legitimate business purposes. Do not misuse the service, attempt to bypass its security, submit unlawful content or interfere with other users.</p>
    <h2>Build Blueprints</h2><p>A free Build Blueprint is an initial planning aid based on the information you provide. It is not a final engineering specification, binding quote, legal advice or guarantee that LFG will accept the project.</p>
    <h2>Build Sprint offers</h2><p>CAD $999 is a starting price for accepted projects that fit the stated Build Sprint constraints. Scope, price, schedule, ownership and support terms are confirmed in a separate project agreement before paid work begins.</p>
    <h2>Availability and liability</h2><p>The website is provided on an as-available basis. To the extent permitted by law, LFG is not liable for indirect or consequential loss arising from use of the public website or an initial blueprint.</p>
    <h2>Contact</h2><p>Questions about these terms can be sent to <a href="mailto:hello@lfg.run">hello@lfg.run</a>.</p>
  `}
  </article></div></body></html>`;
}
