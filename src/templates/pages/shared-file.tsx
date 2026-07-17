import { html, raw } from "hono/html";

interface SharedFilePageProps {
  file: {
    name: string;
    type: string;
    content: string;
  };
  project: {
    name: string;
    icon: string;
  };
}

export function SharedFilePage({ file, project }: SharedFilePageProps) {
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${file.name} — ${project.name} — LFG</title>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <script src="/public/js/marked.min.js"></script>
  <style>
    body { background: var(--bg-color); margin: 0; padding: 0; }
    .shared-container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
    .shared-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .shared-header-icon { font-size: 1.5rem; }
    .shared-header-title { font-size: 1.125rem; font-weight: 600; color: var(--text-color); }
    .shared-header-subtitle { font-size: 0.8125rem; color: var(--text-secondary); }
    .shared-content { color: var(--text-color); line-height: 1.7; font-size: 0.9375rem; }
    .shared-content h1 { font-size: 1.5rem; margin: 1.5rem 0 0.75rem; }
    .shared-content h2 { font-size: 1.25rem; margin: 1.25rem 0 0.625rem; }
    .shared-content h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
    .shared-content p { margin: 0.75rem 0; }
    .shared-content code { background: rgba(255,255,255,0.05); padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.875em; }
    .shared-content pre { background: rgba(0,0,0,0.3); padding: 1rem; border-radius: var(--radius); overflow-x: auto; }
    .shared-content pre code { background: none; padding: 0; }
    .shared-content ul, .shared-content ol { padding-left: 1.5rem; }
    .shared-content li { margin: 0.25rem 0; }
    .shared-content table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    .shared-content th, .shared-content td { padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); text-align: left; font-size: 0.875rem; }
    .shared-content th { background: rgba(255,255,255,0.03); font-weight: 600; }
    .shared-branding { text-align: center; padding: 2rem 0; margin-top: 3rem; border-top: 1px solid var(--border-color); }
    .shared-branding a { font-size: 0.8125rem; color: var(--text-secondary); text-decoration: none; }
  </style>
</head>
<body>
  <div class="shared-container">
    <div class="shared-header">
      <span class="shared-header-icon">${project.icon}</span>
      <div>
        <div class="shared-header-title">${file.name}</div>
        <div class="shared-header-subtitle">from ${project.name}</div>
      </div>
    </div>
    <div class="shared-content" id="content"></div>
    <div class="shared-branding">
      <a href="/">Built with LFG</a>
    </div>
  </div>
  <script>
    var raw = ${raw(JSON.stringify(file.content).replace(/</g, "\\u003c"))};
    if (typeof marked !== 'undefined') {
      document.getElementById('content').innerHTML = marked.parse(raw);
    } else {
      document.getElementById('content').textContent = raw;
    }
  </script>
</body>
</html>`;
}
