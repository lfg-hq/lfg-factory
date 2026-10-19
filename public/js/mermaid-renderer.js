/* Shared Markdown diagram renderer. Source fences remain the saved document format. */
(() => {
    let library, sequence = 0;
    const pending = new WeakMap();
    function load() {
        if (!library) library = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/public/js/vendor/mermaid-11.12.0.min.js';
            script.onload = () => {
                window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default',
                    suppressErrorRendering: true, flowchart: { htmlLabels: false },
                    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'] });
                resolve(window.mermaid);
            };
            script.onerror = () => { library = null; reject(new Error('Diagram library could not load')); };
            document.head.appendChild(script);
        });
        return library;
    }
    // Mermaid ends a statement at ';', so a semicolon inside a sequence message or note
    // ("Save outcome; suppress outreach") breaks the whole diagram. Escape those.
    function repairSource(source) {
        if (!/^\s*sequenceDiagram\b/m.test(source)) return source;
        return source.split('\n').map(line => {
            const colon = line.indexOf(':');
            if (colon < 0 || !/(->>|-->>|->|-->|-x|--x|-\)|--\)|^\s*note\b)/i.test(line.slice(0, colon))) return line;
            return line.slice(0, colon + 1) + line.slice(colon + 1).replace(/;/g, '#59;');
        }).join('\n');
    }
    async function renderSource(api, source) {
        try {
            return await api.render('lfg-diagram-' + (++sequence), source);
        } catch (error) {
            const repaired = repairSource(source);
            if (repaired === source) throw error;
            return api.render('lfg-diagram-' + (++sequence), repaired);
        }
    }
    function expandDiagram(drawing, trigger, source) {
        const svg = drawing.querySelector('svg');
        if (!svg) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'lfg-diagram-viewer';
        dialog.setAttribute('aria-label', 'Expanded diagram');
        dialog.innerHTML = '<header><strong>Diagram</strong><div class="lfg-diagram-controls"><button type="button" data-action="out" aria-label="Zoom out">&minus;</button><output aria-live="polite"></output><button type="button" data-action="in" aria-label="Zoom in">+</button><button type="button" data-action="fit">Fit all</button><button type="button" data-action="width">Fit width</button><button type="button" data-action="layout" aria-pressed="false">Horizontal</button><button type="button" data-action="close" class="lfg-diagram-close" aria-label="Close expanded diagram" title="Close">&times;</button></div></header><div class="lfg-diagram-viewport" tabindex="0" aria-label="Diagram; scroll to explore when zoomed"><div class="lfg-diagram-canvas"></div></div>';
        const viewport = dialog.querySelector('.lfg-diagram-viewport');
        const canvas = dialog.querySelector('.lfg-diagram-canvas');
        const originalStyle = svg.getAttribute('style');
        let activeSvg = svg;
        const bounds = svg.viewBox.baseVal;
        let width = bounds.width || svg.getBoundingClientRect().width || 800;
        let height = bounds.height || svg.getBoundingClientRect().height || 400;
        let scale = 1, sizing = 'width', horizontal = false, layoutVersion = 0;
        const declaration = /^(\s*(?:flowchart|graph)[ \t]+)(TB|TD|BT|RL|LR)(?=[\s;]|$)/m;
        const layoutButton = dialog.querySelector('[data-action="layout"]');
        layoutButton.hidden = !declaration.test(source);
        const status = document.createElement('span');
        status.className = 'lfg-diagram-status';
        status.setAttribute('role', 'status');
        dialog.querySelector('header').appendChild(status);
        const zoom = value => {
            const maxScale = Math.max(4, (viewport.clientWidth - 48) / width);
            scale = Math.max(0.1, Math.min(maxScale, value));
            activeSvg.style.width = (width * scale) + 'px';
            activeSvg.style.height = (height * scale) + 'px';
            activeSvg.style.maxWidth = 'none';
            dialog.querySelector('output').textContent = Math.round(scale * 100) + '%';
            dialog.querySelector('[data-action="out"]').disabled = scale <= 0.1;
            dialog.querySelector('[data-action="in"]').disabled = scale >= maxScale;
        };
        // Automatic fits stop at 150%: past that a small diagram only gets blurry, not clearer.
        const fitScale = (w, h, mode) => Math.min(1.5, mode === 'width' ? (viewport.clientWidth - 48) / w
            : Math.min((viewport.clientWidth - 48) / w, (viewport.clientHeight - 48) / h));
        const fit = () => {
            if (sizing === 'manual') return;
            zoom(fitScale(width, height, sizing));
        };
        const renderHorizontal = async () => {
            const api = await load();
            const result = await renderSource(api, source.replace(declaration, '$1LR'));
            const holder = document.createElement('div');
            holder.innerHTML = result.svg;
            const next = holder.querySelector('svg');
            if (!next) throw new Error('No diagram');
            next.setAttribute('aria-label', 'Mermaid diagram, horizontal layout');
            return next;
        };
        // Open in whichever orientation shows the text largest when fitted to the width;
        // scrolling down a tall diagram reads better than squinting at a long strip.
        const chooseLayout = async () => {
            try {
                const candidate = await renderHorizontal();
                if (restored) return;
                const box = candidate.viewBox.baseVal;
                const current = fitScale(width, height, 'width');
                const other = fitScale(box.width, box.height, 'width');
                const tie = Math.abs(other - current) < 0.05;
                if (other > current + 0.05 || (tie && box.height * other < height * current)) {
                    canvas.replaceChildren(candidate);
                    activeSvg = candidate; width = box.width; height = box.height; horizontal = true;
                    layoutButton.setAttribute('aria-pressed', 'true');
                    layoutButton.textContent = 'Original layout';
                    fit();
                }
            } catch (_) { /* The original layout is already showing. */ }
        };
        const changeLayout = async () => {
            const version = ++layoutVersion;
            layoutButton.disabled = true;
            status.textContent = 'Arranging diagram…';
            try {
                const nextHorizontal = !horizontal;
                let nextSvg = svg;
                if (nextHorizontal) nextSvg = await renderHorizontal();
                if (restored || version !== layoutVersion) return;
                canvas.replaceChildren(nextSvg);
                activeSvg = nextSvg;
                width = nextSvg.viewBox.baseVal.width;
                height = nextSvg.viewBox.baseVal.height;
                horizontal = nextHorizontal;
                layoutButton.setAttribute('aria-pressed', String(horizontal));
                layoutButton.textContent = horizontal ? 'Original layout' : 'Horizontal';
                sizing = 'width';
                fit();
                viewport.scrollTo(0, 0);
                status.textContent = '';
            } catch (_) {
                if (!restored) status.textContent = 'Could not rearrange this diagram. Try Fit width.';
            } finally {
                if (!restored) layoutButton.disabled = false;
            }
        };
        const close = () => { dialog.close(); restore(); };
        canvas.appendChild(svg); // Move rather than clone: SVG marker IDs stay unique.
        document.body.appendChild(dialog);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        let restored = false;
        const restore = () => {
            if (restored) return;
            restored = true;
            if (originalStyle === null) svg.removeAttribute('style'); else svg.setAttribute('style', originalStyle);
            drawing.appendChild(svg);
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('resize', fit);
            window.removeEventListener('beforeprint', close);
            dialog.remove();
            if (trigger.isConnected) trigger.focus();
        };
        dialog.addEventListener('close', restore, { once: true });
        dialog.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'in') { sizing = 'manual'; zoom(scale * 1.25); }
            if (action === 'out') { sizing = 'manual'; zoom(scale / 1.25); }
            if (action === 'fit' || action === 'width') { sizing = action; fit(); viewport.scrollTo(0, 0); }
            if (action === 'layout') changeLayout();
            if (action === 'close' || event.target === dialog) close();
        });
        dialog.addEventListener('keydown', event => {
            if (['+', '=', '-', '0'].includes(event.key)) {
                event.preventDefault();
                if (event.key === '0') { sizing = 'fit'; fit(); } else { sizing = 'manual'; zoom(scale * (event.key === '-' ? 0.8 : 1.25)); }
            }
        });
        window.addEventListener('resize', fit);
        window.addEventListener('beforeprint', close);
        dialog.showModal();
        fit();
        if (!layoutButton.hidden) void chooseLayout();
        dialog.querySelector('[data-action="close"]').focus();
    }
    async function render(root = document) {
        const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
        await Promise.all(blocks.map(code => {
            if (pending.has(code)) return pending.get(code);
            if (code.closest('[contenteditable="true"], .codex-editor, .lfg-diagram, [data-streaming="true"], .orchestrator-streaming')) return;
            const job = (async () => {
                const pre = code.parentElement;
                try {
                    const api = await load();
                    const { svg } = await renderSource(api, code.textContent);
                    if (!pre.isConnected) return;
                    const figure = document.createElement('figure');
                    figure.className = 'lfg-diagram';
                    const drawing = document.createElement('div');
                    drawing.className = 'lfg-diagram-drawing';
                    drawing.innerHTML = svg;
                    const renderedSvg = drawing.querySelector('svg');
                    renderedSvg?.setAttribute('aria-label', 'Mermaid diagram');
                    const nativeWidth = renderedSvg?.viewBox.baseVal.width;
                    if (nativeWidth) drawing.style.setProperty('--diagram-width', nativeWidth + 'px');
                    const nativeHeight = renderedSvg?.viewBox.baseVal.height;
                    if (nativeWidth && nativeHeight) drawing.style.setProperty('--diagram-ratio', String(nativeWidth / nativeHeight));
                    const details = document.createElement('details');
                    const summary = document.createElement('summary');
                    summary.textContent = 'Diagram source';
                    details.append(summary, pre.cloneNode(true));
                    const toolbar = document.createElement('div');
                    toolbar.className = 'lfg-diagram-toolbar';
                    const expand = document.createElement('button');
                    expand.type = 'button';
                    expand.className = 'lfg-diagram-expand';
                    expand.textContent = 'Expand';
                    expand.setAttribute('aria-label', 'Expand diagram');
                    expand.addEventListener('click', () => expandDiagram(drawing, expand, code.textContent));
                    toolbar.appendChild(expand);
                    figure.append(toolbar, drawing, details);
                    pre.replaceWith(figure);
                } catch (error) {
                    if (!pre.isConnected) return;
                    pre.dataset.diagramError = 'true';
                    pre.title = 'Unable to render diagram. Mermaid source is shown.';
                    const notice = document.createElement('p');
                    notice.textContent = pre.title;
                    notice.className = 'diagram-error';
                    pre.before(notice);
                }
            })();
            pending.set(code, job);
            return job;
        }));
    }
    window.renderMermaidDiagrams = render;
    window.prepareMermaidForExport = async root => {
        await render(root);
        // html2canvas does not reliably capture inline SVG. Decode an SVG image first.
        await Promise.all([...root.querySelectorAll('.lfg-diagram-drawing svg')].map(async svg => {
            const image = new Image();
            const bounds = svg.getBoundingClientRect();
            const copy = svg.cloneNode(true);
            copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            copy.setAttribute('width', String(bounds.width || 736));
            copy.setAttribute('height', String(bounds.height || 400));
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
            image.alt = 'Diagram';
            image.style.maxWidth = '100%';
            image.style.maxHeight = '900px';
            image.style.width = 'auto';
            image.style.height = 'auto';
            await image.decode();
            svg.replaceWith(image);
        }));
        root.querySelectorAll('.lfg-diagram details, .lfg-diagram-toolbar').forEach(el => el.remove());
    };
    const style = document.createElement('style');
    style.textContent = '.lfg-diagram{margin:16px 0;padding:16px;background:#fff;color:#182230;border:1px solid #dce1e8;border-radius:10px;break-inside:avoid}.lfg-diagram-drawing{overflow:hidden;text-align:center}.lfg-diagram-drawing>svg{display:block;margin:0 auto;width:min(100%,var(--diagram-width,800px),calc(min(360px,45vh) * var(--diagram-ratio,1)));min-width:0;max-width:100%!important;height:auto}.lfg-diagram summary{cursor:pointer;font-size:12px;margin-top:12px}.lfg-diagram details pre{white-space:pre-wrap}@media print{.lfg-diagram details{display:none}.lfg-diagram{overflow:visible;break-inside:avoid}.lfg-diagram-drawing{overflow:visible;max-height:none}.lfg-diagram-drawing>svg{width:min(100%,var(--diagram-width,800px));min-width:0;max-width:100%!important}}';
    style.textContent += `
.lfg-diagram-toolbar{display:flex;justify-content:flex-end;margin-bottom:8px}
.lfg-diagram-expand,.lfg-diagram-viewer button{font:inherit;font-size:13px;border:1px solid #dce1e8;background:#fff;color:#334155;border-radius:8px;padding:6px 10px;cursor:pointer}
.lfg-diagram-expand:hover,.lfg-diagram-viewer button:hover{background:#f3f0ff;color:#6d28d9}
.lfg-diagram-viewer button:disabled{opacity:.4;cursor:default}
.lfg-diagram-expand:focus-visible,.lfg-diagram-viewer button:focus-visible{outline:2px solid #7c3aed;outline-offset:2px}
.lfg-diagram-viewer{position:fixed;inset:0;margin:auto;box-sizing:border-box;width:96vw;max-width:none;height:92dvh;max-height:92dvh;padding:0;border:1px solid #dce1e8;border-radius:16px;background:white;color:#182230;box-shadow:0 24px 80px #0004}
.lfg-diagram-viewer[open]{display:flex;flex-direction:column}
.lfg-diagram-viewer::backdrop{background:rgba(15,23,42,.65)}
.lfg-diagram-viewer header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid #e2e8f0;flex-shrink:0;font:14px system-ui}
.lfg-diagram-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.lfg-diagram-viewer header{flex-wrap:wrap}
.lfg-diagram-status:empty{display:none}
.lfg-diagram-status{flex-basis:100%;font-size:12px;color:#64748b}
.lfg-diagram-viewer button[aria-pressed="true"]{background:#ede9fe;color:#6d28d9}
.lfg-diagram-viewer .lfg-diagram-close{font-size:20px;line-height:1;width:34px;height:34px;padding:0}
.lfg-diagram-controls output{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.lfg-diagram-viewport{flex:1;min-height:0;overflow:auto;background:#f8fafc}
.lfg-diagram-canvas{box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-width:100%;min-height:100%;width:max-content;padding:24px}
.lfg-diagram-canvas svg{flex-shrink:0;background:white}
@media(max-width:480px){.lfg-diagram-viewer header{padding:10px;gap:6px}.lfg-diagram-controls{gap:4px}.lfg-diagram-viewer button{padding:6px 8px}}
@media print{.lfg-diagram-toolbar,.lfg-diagram-viewer{display:none!important}}`;
    document.head.appendChild(style);
    let timer;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => render(), 180); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-streaming', 'class'] });
    schedule();
})();
