import { html } from "hono/html";

/**
 * MEETING BOTS (LFG admins): the seats the meeting bot joins calls from, and signing each in
 * to the bot's Google account. One seat is one call at a time, so the ready seats are how many
 * calls LFG can be in at once.
 *
 * Behaviour lives in /public/js/meeting-bots.js, not inline: inline scripts in these templates
 * break on ordinary JS escapes.
 */
interface Props {
  user: { name: string; email?: string };
  /** Starting value of the "Google account" field. */
  defaultAccount: string;
}

export function MeetingBotsPage({ user, defaultAccount }: Props) {
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>Meeting bots — LFG</title>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <style>
    body { background: var(--background-color, var(--body-bg)); color: var(--text-color); }
    .mb-page { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
    .mb-back { font-size: 0.82rem; color: var(--text-secondary); text-decoration: none; }
    .mb-page h1 { font-size: 1.3rem; margin: 0.6rem 0 0.35rem; }
    .mb-lead { color: var(--text-secondary); font-size: 0.88rem; line-height: 1.55; margin: 0 0 1.2rem; }
    .mb-summary { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
    .mb-stat { border: 1px solid var(--border-color); border-radius: 10px; padding: 0.6rem 0.9rem; min-width: 130px; }
    .mb-stat b { display: block; font-size: 1.25rem; }
    .mb-stat span { font-size: 0.75rem; color: var(--text-secondary); }
    .mb-add { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.4rem; }
    .mb-add input { flex: 1; min-width: 240px; }
    .mb-note { font-size: 0.82rem; min-height: 1.2em; color: var(--text-secondary); margin: 0.3rem 0 1rem; }
    .mb-note.error { color: #ef4444; }
    table.mb-seats { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    .mb-seats th { text-align: left; font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border-color); }
    .mb-seats td { padding: 0.65rem 0.5rem; border-bottom: 1px solid var(--border-color); vertical-align: top; }
    .mb-pill { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; border: 1px solid; white-space: nowrap; }
    .mb-pill.ready { color: #22c55e; } .mb-pill.needs_sign_in { color: #f59e0b; } .mb-pill.disabled { color: var(--text-secondary); } .mb-pill.busy { color: #3b82f6; }
    .mb-err { color: #ef4444; font-size: 0.78rem; margin-top: 0.25rem; }
    .mb-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; justify-content: flex-end; }
    .mb-actions button { font-size: 0.78rem; padding: 0.3rem 0.6rem; }
    .mb-screen { margin-top: 1.5rem; border: 1px solid var(--border-color); border-radius: 12px; padding: 1rem; }
    .mb-screen[hidden] { display: none; }
    .mb-screen h2 { font-size: 1rem; margin: 0 0 0.35rem; }
    .mb-screen p { font-size: 0.84rem; color: var(--text-secondary); margin: 0 0 0.75rem; line-height: 1.5; }
    .mb-screen iframe { width: 100%; height: 640px; border: 1px solid var(--border-color); border-radius: 8px; background: #111; }
    .mb-screen .mb-actions { justify-content: flex-start; margin-top: 0.75rem; }
  </style>
</head>
<body>
  <main class="mb-page" id="meeting-bots" data-default-account="${defaultAccount}">
    <a class="mb-back" href="/projects">&larr; Back to projects</a>
    <h1>Meeting bots</h1>
    <p class="mb-lead">The browsers LFG joins Google Meet calls from. Each seat is signed in once to a Google account and is in one call at a time, so ready seats are how many calls LFG can be in at once. Add seats as calls grow, and spread them over a few Google accounts so no single account is in too many calls at once. Companies whose Google Workspace blocks outside participants have to allow external guests, or invite the bot's account, for it to join.</p>

    <div class="mb-summary" id="mb-summary"></div>

    <form class="mb-add" id="mb-add">
      <input class="input" id="mb-account" type="email" placeholder="Google account for the new seat" autocomplete="off" />
      <button class="btn btn-primary" type="submit">Add seat</button>
    </form>
    <p class="mb-note" id="mb-note"></p>

    <table class="mb-seats">
      <thead><tr><th>Google account</th><th>State</th><th>Last used</th><th></th></tr></thead>
      <tbody id="mb-rows"><tr><td colspan="4">Loading…</td></tr></tbody>
    </table>

    <section class="mb-screen" id="mb-screen" hidden>
      <h2>Sign this seat in</h2>
      <p>This is the seat's browser, shown through LFG. Sign in to Google here as <b id="mb-screen-account"></b>, including any 2-step verification. When Meet or your Google account page shows you signed in, press <b>I've signed in</b>. LFG reads which account is signed in, saves it to the seat and closes the browser. An unfinished sign-in closes by itself after 20 minutes.</p>
      <iframe id="mb-frame" title="The seat's browser" referrerpolicy="no-referrer"></iframe>
      <div class="mb-actions">
        <button class="btn btn-primary" id="mb-finish" type="button">I've signed in</button>
        <button class="btn" id="mb-cancel" type="button">Cancel</button>
      </div>
    </section>
  </main>
  <script src="/public/js/meeting-bots.js?v=1"></script>
</body>
</html>`;
}
