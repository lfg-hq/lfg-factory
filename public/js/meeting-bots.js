/* Meeting bots page (LFG admins): list the bot's seats, add them, sign them in to Google. */
(function () {
  var root = document.getElementById("meeting-bots");
  if (!root) return;
  var rows = document.getElementById("mb-rows");
  var note = document.getElementById("mb-note");
  var summary = document.getElementById("mb-summary");
  var screen = document.getElementById("mb-screen");
  var frame = document.getElementById("mb-frame");
  var accountInput = document.getElementById("mb-account");
  var openSeat = null; // the seat whose browser is shown
  var seats = [];

  accountInput.value = root.getAttribute("data-default-account") || "";

  var STATE = { ready: "Ready", needs_sign_in: "Needs sign-in", disabled: "Off" };

  function say(text, isError) {
    note.textContent = text || "";
    note.className = "mb-note" + (isError ? " error" : "");
  }

  function api(method, path, body) {
    return fetch("/api/admin/meeting-bots" + path, {
      method: method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "That didn't work.");
        return data;
      });
    });
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function when(value) {
    if (!value) return "Never";
    var d = new Date(value);
    return isNaN(d) ? "" : d.toLocaleString();
  }

  function button(label, onClick, primary) {
    var b = el("button", { type: "button", class: "btn" + (primary ? " btn-primary" : "") }, label);
    b.addEventListener("click", function () {
      b.disabled = true;
      Promise.resolve(onClick()).catch(function (e) { say(e.message, true); }).then(function () { b.disabled = false; });
    });
    return b;
  }

  function renderSummary() {
    var ready = seats.filter(function (s) { return s.state === "ready"; });
    var inCall = seats.filter(function (s) { return s.inCall; }).length;
    var accounts = {};
    ready.forEach(function (s) { if (s.account) accounts[s.account] = (accounts[s.account] || 0) + 1; });
    summary.textContent = "";
    [[ready.length, "ready seats (calls at once)"], [inCall, "in a call now"], [Object.keys(accounts).length, "Google accounts"],
     [seats.filter(function (s) { return s.state === "needs_sign_in"; }).length, "need sign-in"]].forEach(function (pair) {
      var box = el("div", { class: "mb-stat" });
      box.appendChild(el("b", null, String(pair[0])));
      box.appendChild(el("span", null, pair[1]));
      summary.appendChild(box);
    });
  }

  function render() {
    renderSummary();
    rows.textContent = "";
    if (!seats.length) {
      var empty = el("tr");
      empty.appendChild(el("td", { colspan: "4" }, "No seats yet. Add one, then sign it in."));
      rows.appendChild(empty);
    }
    seats.forEach(function (seat) {
      var tr = el("tr");
      var who = el("td");
      who.appendChild(el("div", null, seat.account || "Not signed in"));
      if (seat.lastError) who.appendChild(el("div", { class: "mb-err" }, seat.lastError));
      tr.appendChild(who);

      var state = el("td");
      var label = seat.signingIn ? "Signing in" : seat.inCall ? "In a call" : (STATE[seat.state] || seat.state);
      state.appendChild(el("span", { class: "mb-pill " + (seat.signingIn || seat.inCall ? "busy" : seat.state) }, label));
      tr.appendChild(state);

      tr.appendChild(el("td", null, when(seat.lastUsedAt)));

      var actions = el("div", { class: "mb-actions" });
      if (seat.signingIn && seat.signingIn.byMe) {
        actions.appendChild(button("Show browser", function () { show(seat); }, true));
      } else if (!seat.signingIn && !seat.inCall) {
        actions.appendChild(button(seat.account ? "Sign in again" : "Sign in", function () { return signIn(seat); }, !seat.account));
        if (seat.state === "disabled" && seat.account) actions.appendChild(button("Turn on", function () { return setState(seat, "ready"); }));
        if (seat.state === "ready") actions.appendChild(button("Turn off", function () { return setState(seat, "disabled"); }));
        actions.appendChild(button("Remove", function () { return remove(seat); }));
      }
      var cell = el("td");
      cell.appendChild(actions);
      tr.appendChild(cell);
      rows.appendChild(tr);
    });
  }

  function load() {
    return api("GET", "").then(function (data) {
      seats = data.seats || [];
      render();
      if (openSeat && !seats.some(function (s) { return s.id === openSeat.id && s.signingIn && s.signingIn.byMe; })) hide();
    }).catch(function (e) { say(e.message, true); });
  }

  function show(seat) {
    openSeat = seat;
    document.getElementById("mb-screen-account").textContent = seat.account || "the bot's Google account";
    var ws = "ws/meeting-bot-screen?seat=" + encodeURIComponent(seat.id);
    frame.src = "/admin/meeting-bots/" + encodeURIComponent(seat.id) + "/screen/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=" + encodeURIComponent(ws);
    screen.hidden = false;
    screen.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function hide() {
    openSeat = null;
    frame.src = "about:blank";
    screen.hidden = true;
  }

  function signIn(seat) {
    say("Opening the seat's browser. This can take a minute…");
    return api("POST", "/" + encodeURIComponent(seat.id) + "/sign-in").then(function () {
      say("");
      return load().then(function () { show(seat); });
    });
  }

  function setState(seat, state) {
    return api("POST", "/" + encodeURIComponent(seat.id) + "/state", { state: state }).then(load);
  }

  function remove(seat) {
    if (!confirm("Remove this seat? Its browser and the Google sign-in in it are deleted.")) return;
    return api("DELETE", "/" + encodeURIComponent(seat.id)).then(function () { say("Seat removed."); return load(); });
  }

  document.getElementById("mb-finish").addEventListener("click", function () {
    if (!openSeat) return;
    var b = this;
    b.disabled = true;
    say("Checking the sign-in…");
    api("POST", "/" + encodeURIComponent(openSeat.id) + "/finish").then(function (data) {
      say("Signed in as " + data.account + ". The seat is ready for calls.");
      hide();
      return load();
    }).catch(function (e) { say(e.message, true); }).then(function () { b.disabled = false; });
  });

  document.getElementById("mb-cancel").addEventListener("click", function () {
    if (!openSeat) return;
    var seat = openSeat;
    hide();
    api("POST", "/" + encodeURIComponent(seat.id) + "/cancel").then(load).catch(function (e) { say(e.message, true); });
  });

  document.getElementById("mb-add").addEventListener("submit", function (event) {
    event.preventDefault();
    api("POST", "", { account: accountInput.value.trim() }).then(function () {
      say("Seat added. Sign it in to put it to work.");
      return load();
    }).catch(function (e) { say(e.message, true); });
  });

  load();
  setInterval(function () { if (!document.hidden) load(); }, 15000);
})();
