/* Shared isolation for generated previews in chat, Docs, and new tabs. */
(function () {
    'use strict';
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none';";
    const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    function protect(html) {
        return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '">' + html;
    }
    function sandbox(html) { return /<script[\s>]|name="lfg-design-fidelity" content="captured-layout"/i.test(html) ? 'allow-scripts' : ''; }
    window.DesignPreview = {
        configure(frame, html) {
            // Never grant same-origin, forms, popups or top navigation to generated JS.
            frame.setAttribute('sandbox', sandbox(html));
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.srcdoc = protect(html);
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
