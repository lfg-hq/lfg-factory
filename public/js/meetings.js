// Meetings page: add the agent to a call, list calls with live status, read a call's transcript.
(function () {
  var page = document.getElementById("meetings-page");
  if (!page) return;
  var projectId = page.getAttribute("data-project");
  var botName = page.getAttribute("data-bot") || "LFG";
  var rows = document.getElementById("meeting-rows");
  var note = document.getElementById("meeting-note");
  var form = document.getElementById("meeting-add");
  var open = {}; // meeting id -> { lastSeq } for transcripts the person has opened

  var STATUS = { joining: "Joining", waiting_room: "Waiting to be let in", in_call: "In the call", ended: "Ended", failed: "Could not join" };
  var PLATFORM = { google_meet: "Google Meet" };
  var isLive = function (m) { return m.status === "joining" || m.status === "waiting_room" || m.status === "in_call"; };

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }
  function say(text, isError) {
    note.textContent = text || "";
    note.classList.toggle("error", !!isError);
  }
  function when(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function api(path, options) {
    return fetch("/api/meetings" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}))
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error(body.error || "That did not go through.");
          return body;
        });
      });
  }

  function row(meeting) {
    var wrap = el("div", { "class": "meeting-row", "data-id": meeting.id });
    var top = el("div", { "class": "meeting-top" });
    top.appendChild(el("span", { "class": "meeting-title" }, meeting.title));
    top.appendChild(el("span", { "class": "meeting-pill", "data-status": meeting.status }, STATUS[meeting.status] || meeting.status));
    var actions = el("div", { "class": "meeting-actions" });
    if (meeting.conversationId) {
      var chat = el("a", { "class": "btn btn-secondary", href: "/chat/project/" + projectId + "/conversation/" + meeting.conversationId });
      chat.textContent = "Open chat";
      actions.appendChild(chat);
    }
    actions.appendChild(el("button", { "class": "btn btn-secondary", type: "button", "data-transcript": meeting.id, "aria-expanded": open[meeting.id] ? "true" : "false" }, "Transcript"));
    if (isLive(meeting)) actions.appendChild(el("button", { "class": "btn btn-secondary", type: "button", "data-leave": meeting.id }, "Remove from call"));
    top.appendChild(actions);
    wrap.appendChild(top);
    var meta = (PLATFORM[meeting.platform] || "Call") + " · " + when(meeting.createdAt);
    if (meeting.status === "waiting_room") meta += " · Someone in the call needs to admit " + botName + ".";
    if ((meeting.status === "failed" || meeting.status === "ended") && meeting.statusDetail) meta += " · " + meeting.statusDetail;
    wrap.appendChild(el("div", { "class": "meeting-meta" }, meta));
    var transcript = el("div", { "class": "meeting-transcript", id: "transcript-" + meeting.id });
    if (!open[meeting.id]) transcript.hidden = true;
    wrap.appendChild(transcript);
    return wrap;
  }

  var shown = "";
  function render(list) {
    // Redraw only when something changed, so buttons keep focus between refreshes.
    var signature = JSON.stringify(list.map(function (m) { return [m.id, m.status, m.statusDetail, m.title]; }));
    if (signature === shown) return;
    shown = signature;
    // Keep opened transcripts: their lines are moved into the new rows instead of refetched.
    var kept = {};
    for (var id in open) {
      var old = document.getElementById("transcript-" + id);
      if (old) kept[id] = old;
    }
    rows.textContent = "";
    if (!list.length) {
      rows.appendChild(el("div", { "class": "meetings-empty" }, "No calls yet. Paste a meeting link above to add " + botName + " to one."));
      return;
    }
    list.forEach(function (meeting) {
      var node = row(meeting);
      if (kept[meeting.id]) node.replaceChild(kept[meeting.id], node.lastChild);
      rows.appendChild(node);
    });
  }

  var anyLive = false;
  function load(refresh) {
    return api("?projectId=" + encodeURIComponent(projectId) + "").then(function (body) {
      anyLive = body.meetings.some(isLive);
      render(body.meetings);
      for (var id in open) loadTranscript(id);
    }).catch(function (error) { say(error.message, true); });
  }

  function loadTranscript(id) {
    var state = open[id];
    var box = document.getElementById("transcript-" + id);
    if (!state || !box) return;
    api("/" + id + "?after=" + state.lastSeq).then(function (body) {
      var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      if (!state.lastSeq) box.textContent = "";
      if (!body.segments.length && !state.lastSeq) {
        box.appendChild(el("div", { "class": "meetings-empty" }, "Nothing has been said yet."));
        return;
      }
      body.segments.forEach(function (segment) {
        var line = el("p", { "class": "meeting-line", "data-kind": segment.kind });
        line.appendChild(el("b", null, segment.speaker + (segment.kind === "chat" ? " (chat)" : "") + ": "));
        line.appendChild(document.createTextNode(segment.text));
        box.appendChild(line);
        state.lastSeq = segment.seq;
      });
      if (atBottom) box.scrollTop = box.scrollHeight;
    }).catch(function () { /* next poll retries */ });
  }

  if (form) form.addEventListener("submit", function (event) {
    event.preventDefault();
    var input = document.getElementById("meeting-url");
    var button = document.getElementById("meeting-add-btn");
    button.disabled = true;
    say("Sending " + botName + " to the call…");
    api("", { method: "POST", body: JSON.stringify({ projectId: projectId, meetingUrl: input.value, title: "Meeting · " + when(new Date()) }) }).then(function () {
      input.value = "";
      say(botName + " is joining. Someone in the call will need to admit it.");
      return load(false);
    }).catch(function (error) { say(error.message, true); })
      .then(function () { button.disabled = false; });
  });

  rows.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("button") : null;
    if (!target) return;
    var transcriptId = target.getAttribute("data-transcript");
    var leaveId = target.getAttribute("data-leave");
    if (transcriptId) {
      var box = document.getElementById("transcript-" + transcriptId);
      if (open[transcriptId]) { delete open[transcriptId]; box.hidden = true; box.textContent = ""; target.setAttribute("aria-expanded", "false"); }
      else { open[transcriptId] = { lastSeq: 0 }; box.hidden = false; target.setAttribute("aria-expanded", "true"); loadTranscript(transcriptId); }
    } else if (leaveId) {
      if (!window.confirm("Remove " + botName + " from this call?")) return;
      target.disabled = true;
      api("/" + leaveId + "/leave", { method: "POST", body: "{}" }).then(function () { say(botName + " left the call."); return load(false); })
        .catch(function (error) { say(error.message, true); target.disabled = false; });
    }
  });

  // A link to one call's transcript (from the project Home: #call-<id>) opens it.
  var linked = /^#call-([\w-]+)$/.exec(location.hash);
  if (linked) open[linked[1]] = { lastSeq: 0 };
  load(true).then(function () {
    var node = linked && document.querySelector('.meeting-row[data-id="' + linked[1] + '"]');
    if (node) node.scrollIntoView({ block: "start" });
  });
  // While a call is live, keep status and open transcripts current.
  setInterval(function () { if (anyLive && !document.hidden) load(true); }, 5000);
})();
