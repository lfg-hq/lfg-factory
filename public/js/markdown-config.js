// Configure the marked library for proper markdown rendering including tables

// Strikethrough: require DOUBLE tildes.
//
// GFM's del rule is /^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/ — a SINGLE
// tilde opens a strikethrough. Models write "~" for "approximately" constantly
// ("~30 requests per ~30s", "(~0.8 apps/sec)"), and any two of those pair up the
// moment the closing one follows a non-space character like "(" — striking
// through everything in between, sometimes half a message. Restricting the
// opener to "~~" keeps real strikethrough working and leaves prose tildes alone.
//
// Applied at load (not on DOMContentLoaded) so nothing can render markdown
// before the rule is in place. marked.min.js is loaded before this file.
if (typeof marked !== 'undefined' && typeof marked.use === 'function') {
    marked.use({
        tokenizer: {
            del(src) {
                const match = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?=[^~]|$)/.exec(src);
                // Return undefined, NOT false — marked treats false as "fall back to
                // the built-in tokenizer", which would reinstate the single-tilde rule.
                if (!match) return undefined;
                return {
                    type: 'del',
                    raw: match[0],
                    text: match[1],
                    tokens: this.lexer.inlineTokens(match[1]),
                };
            },
        },
    });
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof marked !== 'undefined') {
        // Enable GitHub Flavored Markdown
        marked.setOptions({
            gfm: true,          // Enable GitHub Flavored Markdown
            breaks: true,       // Add <br> on line breaks
            headerIds: true,    // Add IDs to headers
            mangle: false,      // Don't mangle header IDs
            tables: true,       // Enable table support
            smartLists: true,   // Improve behavior of lists
            xhtml: false,       // Don't use XHTML compatible tags
            
            // Add syntax highlighting if needed
            highlight: function(code, lang) {
                if (typeof Prism !== 'undefined' && Prism.languages[lang]) {
                    return Prism.highlight(code, Prism.languages[lang], lang);
                }
                return code;
            }
        });
        
        console.log('Marked.js configured with table support and other extensions');
    } else {
        console.error('Marked.js library not found. Markdown may not render correctly.');
    }
}); 