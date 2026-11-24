/* Shared isolation for generated previews in chat, Docs, and new tabs. */
(function () {
    'use strict';
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none';";
    const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    function protect(html) {
        return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '">' + html;
    }
    function sandbox(html) { return /<script[\s>]|name="lfg-design-fidelity" content="captured-layout"/i.test(html) ? 'allow-scripts' : ''; }
    // A button or link that names another screen of the same flow (data-screen="…" or
    // href="#screen:…") tells the chat to open that screen, so a set of screens can be
    // clicked through like a prototype. The frame stays sandboxed without same-origin;
    // all it can do is post the screen's name.
    // Escape inside a screen reaches the chat too, so full screen still closes after
    // a click inside the page took the keyboard focus.
    const SCREEN_LINKS = '<script>document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("[data-screen],a[href^=\'#screen:\']");if(!t)return;var n=t.getAttribute("data-screen")||decodeURIComponent((t.getAttribute("href")||"").slice(8));if(!n)return;e.preventDefault();e.stopPropagation();parent.postMessage({lfgScreen:n},"*");},true);document.addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({lfgScreenEscape:true},"*");});<\/script>';
    window.DesignPreview = {
        configure(frame, html) {
            // Never grant same-origin, forms, popups or top navigation to generated JS.
            // Scripts run without same-origin, so the page stays in its own sealed origin.
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.srcdoc = protect(html) + SCREEN_LINKS;
        },
        open(html) {
            // Blob URLs inherit our origin. Open a trusted wrapper, never raw generated JS.
            const wrapper = '<!doctype html><title>Design preview</title>' +
                '<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>' +
                '<iframe title="Design preview" sandbox="' + sandbox(html) + '" referrerpolicy="no-referrer" srcdoc="' + escapeAttribute(protect(html)) + '"></iframe>';
            const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' }));
            window.open(url, '_blank', 'noopener');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        },
    };
})();
