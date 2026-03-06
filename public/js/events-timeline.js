/**
 * Events Timeline — fetches and renders project activities.
 * Polls every 10s for new events.
 */
(function () {
  const container = document.getElementById("events-timeline-container");
  const tabContainer = document.getElementById("events-tab-container");
  if (!container || !tabContainer) return;

  const projectId = tabContainer.dataset.projectId;
  if (!projectId) return;

  const POLL_INTERVAL = 10_000;
  let knownIds = new Set();
  let pollTimer = null;

  // Icon + dot-class mapping per activity type
  const TYPE_CONFIG = {
    ticket_queued:          { icon: "fa-clock",        dotClass: "event-dot--queued" },
    ticket_started:         { icon: "fa-play",         dotClass: "event-dot--started" },
    ticket_completed:       { icon: "fa-check-circle", dotClass: "event-dot--completed" },
    ticket_failed:          { icon: "fa-times-circle", dotClass: "event-dot--failed" },
    ticket_stuck:           { icon: "fa-exclamation-triangle", dotClass: "event-dot--stuck" },
    git_pushed:             { icon: "fa-code-branch",  dotClass: "event-dot--git_pushed" },
    git_merged:             { icon: "fa-code-merge",   dotClass: "event-dot--git_merged" },
    orchestrator_queued_next: { icon: "fa-forward",    dotClass: "event-dot--auto_queued" },
    user_action_required:   { icon: "fa-hand-paper",   dotClass: "event-dot--user_action" },
  };

  function getConfig(activityType) {
    return TYPE_CONFIG[activityType] || { icon: "fa-info-circle", dotClass: "event-dot--queued" };
  }

  function formatTime(dateVal) {
    const d = new Date(typeof dateVal === "number" ? dateVal * 1000 : dateVal);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function renderActivity(activity) {
    const config = getConfig(activity.activityType);
    const item = document.createElement("div");
    item.className = "event-item";
    item.dataset.activityId = activity.id;

    item.innerHTML = `
      <div class="event-dot ${config.dotClass}">
        <i class="fas ${config.icon}"></i>
      </div>
      <div class="event-card">
        <p class="event-card__title">
          <i class="fas ${config.icon}"></i>
          ${escapeHtml(activity.title)}
        </p>
        ${activity.description ? `<p class="event-card__description">${escapeHtml(activity.description)}</p>` : ""}
        <div class="event-card__time">${formatTime(activity.createdAt)}</div>
      </div>
    `;
    return item;
  }

  function renderTimeline(activities) {
    if (activities.length === 0) {
      container.innerHTML = `
        <div class="events-empty">
          <i class="fas fa-stream"></i>
          <p style="margin:0 0 0.5rem;">No events yet.</p>
          <p style="font-size:0.85rem;margin:0;">Queue a ticket to see activity here.</p>
        </div>
      `;
      return;
    }

    // Build or reuse timeline wrapper
    let timeline = container.querySelector(".events-timeline");
    if (!timeline) {
      container.innerHTML = "";
      timeline = document.createElement("div");
      timeline.className = "events-timeline";
      container.appendChild(timeline);
    }

    // Render newest-first
    for (const activity of activities) {
      if (knownIds.has(activity.id)) continue;
      knownIds.add(activity.id);
      const el = renderActivity(activity);
      timeline.prepend(el);
    }
  }

  async function fetchActivities() {
    try {
      const res = await fetch(`/projects/${projectId}/api/activities?limit=50`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.activities) {
        // Reverse so we prepend oldest first (newest ends up on top)
        renderTimeline(data.activities.reverse());
      }
    } catch (err) {
      console.error("[events-timeline] Fetch error:", err);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Initial fetch
  fetchActivities();

  // Poll for new events
  pollTimer = setInterval(fetchActivities, POLL_INTERVAL);

  // Clean up on navigation (if SPA-like behavior)
  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
