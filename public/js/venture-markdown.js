// Sanitized Markdown for venture analyst output. Model text can carry content
// from untrusted web pages, so raw HTML is escaped, images never load, and only
// http(s)/mailto links survive. Citations [[source:ID]] become numbered links
// to the stored source ledger.
(() => {
  'use strict';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function safeHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) return url;
    } catch { /* invalid URL */ }
    return null;
  }
  const md = window.marked?.Marked ? new window.marked.Marked({ gfm: true, breaks: true }) : null;
  md?.use({ renderer: {
    html: html => esc(html),
    image: (_href, _title, text) => esc(text || ''),
    link(href, title, text) {
      const url = safeHref(href);
      if (!url) return text;
      const external = url.origin !== location.origin ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${esc(url.href)}"${title ? ` title="${esc(title)}"` : ''}${external}>${text}</a>`;
    },
  } });
  function render(text, sources) {
    const order = [];
    const cited = String(text || '').replace(/\[\[source:([\w-]+)\]\]/g, (_m, id) => {
      const source = sources?.get(id), url = source && safeHref(source.url);
      if (!url) return '';
      if (!order.includes(id)) order.push(id);
      return ` [\\[${order.indexOf(id) + 1}\\]](<${url.href}>)`;
    });
    return md ? md.parse(cited) : null;
  }
  window.ventureMarkdown = {
    into(el, text, sources) {
      const html = render(text, sources);
      if (html === null) el.textContent = text; else el.innerHTML = html;
      el.classList.add('va-md');
    },
  };
})();
