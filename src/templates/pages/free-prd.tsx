import { html, raw } from "hono/html";

interface FreePrdPageProps {
  notFound?: boolean;
  id?: string;
  email?: string;
  status?: string;
  title?: string | null;
  projectIdea?: string;
  prdMarkdown?: string | null;
  qualification?: string | null;
  questions?: string[];
}

export function FreePrdPage(props: FreePrdPageProps) {
  const { notFound, id, status, title, projectIdea, prdMarkdown, qualification, questions = [] } = props;

  const pageTitle = title ? `${title} — Build Blueprint — LFG` : "Your Build Blueprint — LFG";
  const inProgress = status === "pending_verification" || status === "assessing" || status === "generating";

  const head = html`<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
    <title>${pageTitle}</title>
    <script src="/public/js/marked.min.js"></script>
    <style>
      :root { --brand:#4f46e5; --brand-700:#4338ca; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f8fafc; }
      * { box-sizing: border-box; }
      body { background: var(--bg); margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
      .wrap { max-width: 820px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
      .brand { display:flex; align-items:center; gap:.5rem; font-weight:800; font-size:1.15rem; margin-bottom:2rem; color:var(--ink); text-decoration:none; }
      .brand-mark { width:32px; height:32px; border-radius:8px; background:var(--brand); display:flex; align-items:center; justify-content:center; color:#fff; }
      .card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:2rem; box-shadow:0 1px 3px rgba(15,23,42,.04); }
      .eyebrow { text-transform:uppercase; letter-spacing:.08em; font-size:.72rem; font-weight:700; color:var(--brand); margin-bottom:.5rem; }
      h1 { font-size:1.7rem; margin:.2rem 0 .6rem; line-height:1.2; }
      .muted { color:var(--muted); }
      .idea { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:.9rem 1rem; font-size:.9rem; color:#334155; margin:1rem 0; white-space:pre-wrap; }
      .spinner { width:38px; height:38px; border:3px solid var(--line); border-top-color:var(--brand); border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 1rem; }
      @keyframes spin { to { transform:rotate(360deg); } }
      .center { text-align:center; }
      button, .btn { background:var(--brand); color:#fff; border:none; padding:.7rem 1.3rem; border-radius:10px; font-weight:600; font-size:.95rem; cursor:pointer; text-decoration:none; display:inline-block; }
      button:hover, .btn:hover { background:var(--brand-700); }
      button:disabled { opacity:.6; cursor:default; }
      textarea { width:100%; border:1px solid var(--line); border-radius:10px; padding:.8rem; font-size:.95rem; font-family:inherit; min-height:110px; outline:none; resize:vertical; }
      textarea:focus { border-color:var(--brand); box-shadow:0 0 0 3px rgba(79,70,229,.12); }
      ul.q { padding-left:1.1rem; margin:.75rem 0 1rem; }
      ul.q li { margin:.4rem 0; color:#334155; }
      .err { color:#dc2626; font-size:.85rem; margin-top:.5rem; display:none; }
      .prd { line-height:1.7; font-size:.95rem; color:#1e293b; }
      .prd h1 { font-size:1.7rem; margin:1.4rem 0 .8rem; }
      .prd h2 { font-size:1.3rem; margin:1.6rem 0 .6rem; padding-bottom:.3rem; border-bottom:1px solid var(--line); }
      .prd h3 { font-size:1.08rem; margin:1.1rem 0 .4rem; }
      .prd p { margin:.7rem 0; }
      .prd ul, .prd ol { padding-left:1.4rem; }
      .prd li { margin:.3rem 0; }
      .prd code { background:#f1f5f9; padding:.12rem .38rem; border-radius:4px; font-size:.88em; }
      .prd pre { background:#0f172a; color:#e2e8f0; padding:1rem; border-radius:10px; overflow-x:auto; }
      .prd pre code { background:none; padding:0; color:inherit; }
      .prd table { width:100%; border-collapse:collapse; margin:1rem 0; }
      .prd th, .prd td { border:1px solid var(--line); padding:.5rem .7rem; text-align:left; font-size:.9rem; }
      .prd blockquote { border-left:3px solid var(--brand); margin:1rem 0; padding:.4rem 1rem; background:var(--bg); color:#475569; border-radius:0 8px 8px 0; }
      .toolbar { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
      details.refine { margin-top:2.5rem; border-top:1px solid var(--line); padding-top:1.5rem; }
      details.refine summary { cursor:pointer; font-weight:600; color:var(--brand); list-style:none; }
      details.refine summary::-webkit-details-marker { display:none; }
      .ok { display:none; align-items:center; gap:.6rem; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; padding:.9rem 1rem; border-radius:10px; margin-top:1rem; font-size:.92rem; font-weight:500; }
      .ok .dot { width:16px; height:16px; border:2px solid #c7d2fe; border-top-color:var(--brand); border-radius:50%; animation:spin .9s linear infinite; flex:none; }
      .footer { text-align:center; margin-top:2.5rem; }
      .footer a { color:var(--muted); font-size:.82rem; text-decoration:none; }
    </style>
  </head>`;

  const brand = html`<a class="brand" href="/build-sprint">
    <span class="brand-mark">L</span>
    <span>LFG</span>
  </a>`;

  if (notFound) {
    return html`<!DOCTYPE html><html lang="en">${head}<body>
      <div class="wrap">
        ${brand}
        <div class="card center">
          <h1>This Blueprint link isn't available</h1>
          <p class="muted">The link may be incorrect or the request was never verified.</p>
          <p style="margin-top:1.5rem"><a class="btn" href="/build-sprint#blueprint">Start a new free Blueprint</a></p>
        </div>
        <div class="footer"><a href="/">Built with LFG</a></div>
      </div>
    </body></html>`;
  }

  let bodyInner;

  if (inProgress) {
    bodyInner = html`<div class="card center" id="state">
      <div class="spinner"></div>
      <h1>${title || "Creating your Build Blueprint"}</h1>
      <p class="muted">Our agent is analyzing the workflow, identifying the minimum useful release and determining whether it fits the Build Sprint. This page updates automatically.</p>
      <div class="idea center" style="text-align:left">${projectIdea}</div>
    </div>`;
  } else if (status === "needs_clarification") {
    bodyInner = html`<div class="card">
      <div class="eyebrow">A few quick questions</div>
      <h1>${title || "Let's sharpen your idea"}</h1>
      <p class="muted">Your idea is promising, but we need a little more detail to prepare a useful Build Blueprint:</p>
      <ul class="q">
        ${questions.map((q) => html`<li>${q}</li>`)}
      </ul>
      <form id="refine-form">
        <textarea id="refine-input" placeholder="Answer the questions above — or add anything else that would help us understand what you want to build." required></textarea>
        <div class="err" id="refine-err"></div>
        <div style="margin-top:1rem"><button type="submit" id="refine-btn">Generate my Blueprint</button></div>
      </form>
      <div class="ok" id="refine-ok"><span class="dot"></span><span>Got it — creating your Blueprint now. This page updates automatically…</span></div>
    </div>`;
  } else if (status === "failed") {
    bodyInner = html`<div class="card">
      <div class="eyebrow">Hmm</div>
      <h1>We hit a snag generating your Blueprint</h1>
      <p class="muted">Our team has been notified and will follow up by email. You can also add more detail and try again:</p>
      <form id="refine-form">
        <textarea id="refine-input" placeholder="Add any extra detail about what you want to build…" required></textarea>
        <div class="err" id="refine-err"></div>
        <div style="margin-top:1rem"><button type="submit" id="refine-btn">Try again</button></div>
      </form>
      <div class="ok" id="refine-ok"><span class="dot"></span><span>Thanks — trying again now. This page updates automatically…</span></div>
    </div>`;
  } else {
    // ready
    bodyInner = html`<div class="card">
      <div class="toolbar">
        <div>
          <div class="eyebrow">Your free Build Blueprint</div>
          <h1 style="margin-bottom:0">${title || "Product Requirements"}</h1>
        </div>
        <a class="btn" href="/build-sprint#blueprint">${qualification === "Qualifies for Build Sprint" ? "Apply for the CAD $999 Build Sprint" : qualification === "Requires scoped fixed-price proposal" ? "Schedule a fixed-price scoping call" : "Clarify my project with LFG"} →</a>
      </div>
      <div class="prd" id="prd-content"></div>

      <details class="refine">
        <summary>Request changes or keep building →</summary>
        <p class="muted" style="margin-top:.8rem">Tell us what to change, add, or expand. We'll regenerate the Blueprint with your feedback.</p>
        <form id="refine-form">
          <textarea id="refine-input" placeholder="e.g. Add a mobile app, focus on the admin dashboard, include a payments flow…" required></textarea>
          <div class="err" id="refine-err"></div>
          <div style="margin-top:1rem"><button type="submit" id="refine-btn">Update my Blueprint</button></div>
        </form>
        <div class="ok" id="refine-ok"><span class="dot"></span><span>Got it — updating your Blueprint now. This page updates automatically…</span></div>
      </details>
    </div>`;
  }

  // Strip the leading H1 here (server-side) — the page header already shows the
  // title, and doing regex work inside the client <script> template is fragile
  // (backslash escapes get cooked away by the template literal).
  const prdBody = (prdMarkdown || "").replace(/^\s*#\s+.+\n+/, "");

  // Embed page data as JSON via raw() so Hono doesn't HTML-escape the quotes
  // (which would corrupt the script). Escaping "<" guards against "</script>".
  const pageData = raw(
    JSON.stringify({ id: id || "", status: status || "", prd: prdBody }).replace(/</g, "\\u003c")
  );

  const scripts = html`<script>
    (function () {
      var DATA = ${pageData};
      var ID = DATA.id;
      var STATUS = DATA.status;
      var RAW = DATA.prd;

      // Render Markdown, then remove unsafe elements and attributes before display.
      var contentEl = document.getElementById('prd-content');
      if (contentEl) {
        if (typeof marked !== 'undefined') {
          var parsed = new DOMParser().parseFromString(marked.parse(RAW), 'text/html');
          parsed.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta').forEach(function (node) { node.remove(); });
          parsed.querySelectorAll('*').forEach(function (node) {
            Array.from(node.attributes).forEach(function (attr) {
              var name = attr.name.toLowerCase();
              var value = attr.value.trim().toLowerCase();
              if (name.indexOf('on') === 0 || name === 'style' || ((name === 'href' || name === 'src') && (value.indexOf('javascript:') === 0 || value.indexOf('data:') === 0))) node.removeAttribute(attr.name);
            });
          });
          contentEl.replaceChildren.apply(contentEl, Array.from(parsed.body.childNodes));
        } else contentEl.textContent = RAW;
      }

      // Poll while in progress and reload when done
      var IN_PROGRESS = STATUS === 'pending_verification' || STATUS === 'assessing' || STATUS === 'generating';
      if (IN_PROGRESS) {
        var poll = setInterval(function () {
          fetch('/api/free-prd/' + ID + '/status')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.status && d.status !== STATUS && d.status !== 'assessing') {
                clearInterval(poll);
                window.location.reload();
              }
            })
            .catch(function () {});
        }, 3500);
      }

      // Refine / clarify / retry form
      var form = document.getElementById('refine-form');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var input = document.getElementById('refine-input');
          var btn = document.getElementById('refine-btn');
          var err = document.getElementById('refine-err');
          var ok = document.getElementById('refine-ok');
          var answers = (input.value || '').trim();
          err.style.display = 'none';
          if (!answers) return;
          btn.disabled = true; btn.textContent = 'Submitting…';
          fetch('/api/free-prd/' + ID + '/refine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers: answers })
          })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
              if (!res.ok || !res.d.success) {
                err.textContent = (res.d && res.d.error) || 'Something went wrong. Please try again.';
                err.style.display = 'block';
                btn.disabled = false; btn.textContent = 'Try again';
                return;
              }
              // Show a persistent "working" state and poll until the PRD is ready,
              // then reload to reveal it — never silently drop back to the form.
              form.style.display = 'none';
              if (ok) ok.style.display = 'flex';
              var elapsed = 0;
              var t = setInterval(function () {
                elapsed += 3;
                fetch('/api/free-prd/' + ID + '/status')
                  .then(function (r) { return r.json(); })
                  .then(function (d) {
                    if (d.status === 'ready' || d.status === 'needs_clarification' || d.status === 'failed') {
                      clearInterval(t); window.location.reload();
                    }
                  })
                  .catch(function () {});
                if (elapsed >= 90) { clearInterval(t); window.location.reload(); }
              }, 3000);
            })
            .catch(function () {
              err.textContent = 'Network error. Please try again.';
              err.style.display = 'block';
              btn.disabled = false; btn.textContent = 'Try again';
            });
        });
      }
    })();
  </script>`;

  return html`<!DOCTYPE html><html lang="en">${head}<body>
    <div class="wrap">
      ${brand}
      ${bodyInner}
      <div class="footer"><a href="/">Built with LFG · lfg.run</a></div>
    </div>
    ${scripts}
  </body></html>`;
}
