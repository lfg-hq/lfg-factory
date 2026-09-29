/** Package a screen's editable assets into a portable HTML implementation reference. */
export function composeDesignPreview(input: { html: string; css?: string; js?: string; data?: unknown }): string {
  let html = input.html;
  if (!/<html[\s>]/i.test(html) || !/<\/head\s*>/i.test(html) || !/<\/body\s*>/i.test(html)) {
    throw new Error('Preview must be a complete HTML document with head and body.');
  }
  if (input.css) {
    if (/<\/style/i.test(input.css)) throw new Error('CSS must not contain a closing style tag.');
    html = html.replace(/<\/head\s*>/i, () => `<style>${input.css}</style></head>`);
  }
  const assets: string[] = [];
  if (input.data !== undefined) {
    const data = JSON.stringify(input.data).replace(/</g, '\\u003c');
    assets.push(`<script>window.mockData = ${data};</script>`);
  }
  if (input.js) {
    if (/<\/script/i.test(input.js)) throw new Error('JS must not contain a closing script tag.');
    assets.push(`<script>${input.js}</script>`);
  }
  html = html.replace(/<\/body\s*>/i, () => assets.join('\n') + '</body>');
  if (html.length > 400_000) throw new Error('Each design screen must be at most 400,000 characters.');
  return html;
}
