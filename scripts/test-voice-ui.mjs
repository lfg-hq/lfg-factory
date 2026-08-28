/**
 * Voice UI: bun run test:voice
 *
 * The recording panel and the sent voice bubble had NO css at all — the waveform bars
 * were unstyled block divs whose height is rewritten every animation frame, so the
 * panel reflowed continuously (the flicker), and the sent message had no layout, which
 * is why it rendered as a tall empty block.
 */
import fs from "node:fs";
const css = fs.readFileSync("public/css/chat.css", "utf8");
const js = fs.readFileSync("public/js/chat.js", "utf8");
let bad = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { bad++; console.log("  FAIL " + m); };
const rule = (sel) => {
  const i = css.indexOf(sel + " {");
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
};

console.log("the recording panel:");
const bar = rule(".waveform-bar");
if (/width:\s*3px/.test(bar)) ok("bars have a width (they were full-width blocks)");
else fail("bars still have no width");
if (/flex:\s*none/.test(bar)) ok("bars don't stretch");
else fail("bars would flex");
const wave = rule(".audio-waveform");
if (/height:\s*36px/.test(wave)) ok("the waveform has a FIXED height — no reflow per frame");
else fail("waveform height is not fixed; the panel will still jump");
if (/align-items:\s*center/.test(wave)) ok("bars grow from the middle");
else fail("bars anchored oddly");
// Strip comments first: the rule EXPLAINS why there's no transition, and matching
// that sentence is not the same as finding a declaration.
const barDecls = bar.replace(/\/\*[\s\S]*?\*\//g, "");
if (!/(^|[;{\s])transition\s*:/.test(barDecls)) ok("no transition fighting the per-frame audio data");
else fail("a transition would smear the live waveform");
const live = rule(".live-transcription");
if (/max-height/.test(live) && /overflow-y:\s*auto/.test(live)) ok("the transcript scrolls instead of growing the panel");
else fail("a long transcript would resize the panel mid-recording");
if (/\.audio-recording-indicator \{/.test(css)) ok("the panel itself is styled");
else fail("panel unstyled");

console.log("\nthe sent voice message:");
if (/\.message-audio-container \{[^}]*inline-flex/.test(css)) ok("bubble sizes to its content");
else fail("bubble has no layout — the tall empty block");
if (/\.message-audio-header \{[^}]*font-size/.test(css)) ok("the header is styled");
else fail("header unstyled");
if (/\.audio-transcription \{[^}]*white-space:\s*pre-wrap/.test(css)) ok("the transcript wraps properly");
else fail("transcript styling missing");

console.log("\nboth themes:");
if (/\[data-theme="light"\] \.audio-recording-indicator/.test(css)) ok("the panel has a light-mode rule");
else fail("panel would keep dark colours on white");
if (!/background: rgba\(255,255,255,0\.05\)/.test(js.slice(js.indexOf("transcriptionArea.style.cssText"), js.indexOf("transcriptionArea.style.cssText") + 300))) ok("the transcript area uses theme tokens, not hardcoded dark");
else fail("hardcoded dark inline style remains");

console.log(bad ? `\n${bad} FAILED` : "\nall checks pass");
process.exit(bad ? 1 : 0);
