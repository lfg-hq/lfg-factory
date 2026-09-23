// Keep document markup inside the reader; never import document CSS into the app.
window.renderEpicMarkdown = function (host, source) {
    if (typeof marked === 'undefined') { host.textContent = source; return; }
    const doc = new DOMParser().parseFromString(marked.parse(source), 'text/html');
    const allowed = new Set(['P','BR','HR','H1','H2','H3','H4','H5','H6','UL','OL','LI','STRONG','EM','DEL','BLOCKQUOTE','PRE','CODE','TABLE','THEAD','TBODY','TR','TH','TD','A','IMG']);
    doc.querySelectorAll('script,style,link,meta,iframe,object,embed,svg,math,form,input,button,textarea,select').forEach(el => el.remove());
    for (const el of Array.from(doc.body.querySelectorAll('*'))) {
        if (!allowed.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
        const href = el.getAttribute('href');
        const src = el.getAttribute('src');
        const alt = el.getAttribute('alt');
        for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
        const safe = value => { try { return ['http:','https:'].includes(new URL(value, location.href).protocol); } catch { return false; } };
        if (el.tagName === 'A' && href && safe(href)) { el.setAttribute('href', href); el.setAttribute('target','_blank'); el.setAttribute('rel','noopener noreferrer'); }
        if (el.tagName === 'IMG' && src && safe(src)) { el.setAttribute('src',src); el.setAttribute('alt',alt || ''); }
    }
    host.replaceChildren(...doc.body.childNodes);
};
