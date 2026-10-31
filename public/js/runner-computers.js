// Settings → Integrations → Computers: pair, list and revoke LFG Desktop runners.
(function () {
  const list = document.getElementById("runner-device-list");
  const pairing = document.getElementById("runner-pairing");
  const connectBtn = document.getElementById("runner-connect-btn");
  if (!list || !pairing || !connectBtn) return;

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text != null) node.textContent = text;
    return node;
  }
  function ago(value) {
    if (!value) return "never";
    const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function copyRow(label, value, secret) {
    const row = el("div", "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;");
    row.appendChild(el("span", "font-size:.8125rem;color:var(--text-secondary);min-width:6.5rem;", label));
    const code = el("code", "flex:1;min-width:0;overflow-wrap:anywhere;font-size:.8125rem;padding:.35rem .5rem;border-radius:6px;background:rgba(127,127,127,.12);", value);
    row.appendChild(code);
    const btn = el("button", "border-radius:7px;padding:.35rem .7rem;", "Copy");
    btn.type = "button";
    btn.className = "llm-btn-save";
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(value); btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
      catch (_) { btn.textContent = "Select and copy"; }
    });
    row.appendChild(btn);
    if (secret) code.setAttribute("data-secret", "true");
    return row;
  }

  async function load() {
    try {
      const r = await fetch("/api/runner/devices", { credentials: "same-origin" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      render((await r.json()).devices || []);
    } catch (e) {
      list.replaceChildren(el("div", "", "Couldn't load your computers: " + (e.message || e)));
      list.firstChild.className = "byok-desc";
    }
  }

  function render(devices) {
    if (!devices.length) {
      const empty = el("div", "", "No computers connected yet. Connect one, then use “Run on my computer” on a ticket.");
      empty.className = "byok-desc";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...devices.map((d) => {
      const row = el("div", "display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.25rem 0;");
      const left = el("div", "display:flex;align-items:center;gap:.625rem;min-width:0;flex:1;");
      const dot = el("span", "width:8px;height:8px;border-radius:50%;flex:none;background:" + (d.connected ? "#34d399" : "rgba(127,127,127,.5)") + ";");
      dot.title = d.connected ? "Connected" : "Offline";
      left.appendChild(dot);
      const text = el("div", "min-width:0;");
      text.appendChild(el("div", "font-weight:600;color:var(--text-color,#f0f0f0);", d.name));
      const meta = [d.connected ? "Connected" : "Last seen " + ago(d.lastSeenAt), d.platform, d.claudeVersion ? "Claude Code " + d.claudeVersion.replace(/\s*\(Claude Code\)/, "") : (d.lastSeenAt ? "Claude Code not found" : null), d.tokenPrefix + "…"].filter(Boolean).join(" · ");
      const metaEl = el("div", "font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", meta);
      metaEl.title = meta;
      metaEl.className = "byok-desc";
      text.appendChild(metaEl);
      left.appendChild(text);
      row.appendChild(left);
      const revoke = el("button", "border-radius:7px;border:1px solid rgba(239,68,68,0.3);padding:.4rem .8rem;flex:none;", "Revoke");
      revoke.type = "button";
      revoke.className = "llm-btn-remove";
      revoke.addEventListener("click", async () => {
        if (!window.confirm("Revoke " + d.name + "? It disconnects now and can't run builds until you pair it again.")) return;
        revoke.disabled = true;
        await fetch("/api/runner/devices/" + encodeURIComponent(d.id), { method: "DELETE", credentials: "same-origin" }).catch(() => {});
        load();
      });
      row.appendChild(revoke);
      return row;
    }));
  }

  connectBtn.addEventListener("click", async () => {
    const name = window.prompt("Name this computer", "My laptop");
    if (name === null) return;
    connectBtn.disabled = true;
    try {
      const r = await fetch("/api/runner/devices", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      const server = j.serverUrl || window.location.origin;
      const intro = el("div", "", "Open LFG Desktop on that computer and paste these. The token is shown only once.");
      intro.className = "byok-desc";
      const headless = el("div", "font-size:.75rem;", "No desktop app (for example on a Linux box)? Run: lfg-runner --server " + server + " --token <token> --auto-approve");
      headless.className = "byok-desc";
      const done = el("button", "align-self:flex-start;border-radius:7px;padding:.4rem .8rem;", "Done");
      done.type = "button";
      done.className = "llm-btn-save";
      done.addEventListener("click", () => { pairing.style.display = "none"; pairing.replaceChildren(); });
      pairing.replaceChildren(intro, copyRow("LFG address", server), copyRow("Computer token", j.token, true), headless, done);
      pairing.style.display = "flex";
      load();
    } catch (e) {
      window.alert("Couldn't create a token: " + (e.message || e));
    } finally {
      connectBtn.disabled = false;
    }
  });

  load();
  // Pick up a computer coming online without a reload.
  setInterval(() => { if (!document.hidden) load(); }, 15000);
})();
