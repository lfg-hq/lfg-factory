import { html } from "hono/html";
import { ChatInput } from "../components/chat-input.tsx";

interface ComposioToolkit {
  slug: string;
  name: string;
}

interface AgentDetail {
  agentId: string;
  name: string;
  status: string;
  personality: string | null;
  instructions: string | null;
  sandboxUrl: string | null;
  composioToolkits: string[];
  memoryContent: string | null;
  memoryLastSyncedAt: Date | null;
  conversationId: string | null;
  webhookToken: string | null;
  autoStopAfterIdleMs: number | null;
  runTimeoutMs: number | null;
}

interface AgentDetailPageProps {
  user: { id: string; name: string; email: string };
  agent: AgentDetail;
  composioToolkits: ComposioToolkit[];
  modelKey?: string;
  models?: Array<{ key: string; label: string; providerLabel: string; requiresPro: boolean }>;
}

export function AgentDetailPage({
  user,
  agent,
  composioToolkits,
  modelKey = "claude_4.5_sonnet",
  models = [],
}: AgentDetailPageProps) {
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();
  const statusColors: Record<string, string> = {
    idle: "#6b7280",
    starting: "#f59e0b",
    running: "#22c55e",
    paused: "#3b82f6",
    error: "#ef4444",
    stopped: "#6b7280",
  };
  const statusLabels: Record<string, string> = {
    idle: "Ready",
    starting: "Starting",
    running: "Working",
    paused: "Paused",
    error: "Error",
    stopped: "Ready",
  };
  const statusColor = statusColors[agent.status] ?? "#6b7280";
  const statusLabel = statusLabels[agent.status] ?? agent.status;

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${agent.name} — Agents — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/chat.css" />
  <link rel="stylesheet" href="/public/css/artifacts.css" />
  <link rel="stylesheet" href="/public/css/agents.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body
  data-user-id="${user.id}"
  data-user-name="${user.name}"
  data-agent-id="${agent.agentId}"
  data-agent-status="${agent.status}"
  data-model-key="${modelKey}"
>
  <div class="messages" id="toast-container"></div>

  <div class="app-container">
    <!-- Sidebar -->
    <div class="sidebar" id="sidebar">
      <div class="sidebar-top-content">
        <div class="sidebar-header">
          <div class="logo-section">
            <span class="logo-icon">🚀</span>
            <span class="logo-text">LFG</span>
          </div>
          <button id="minimize-btn" class="icon-btn" title="Collapse Sidebar">
            <i class="fas fa-chevron-left"></i>
          </button>
        </div>
        <div class="project-selector-section">
          <a href="/projects" class="project-dropdown-trigger">
            <i class="fas fa-folder"></i>
            <span class="project-name-text">Projects</span>
          </a>
        </div>
        <div class="sidebar-nav">
          <a href="/instant/" class="nav-link">
            <i class="fas fa-bolt"></i>
            <span class="nav-text">Instant Apps</span>
          </a>
          <a href="/projects?tab=agents" class="nav-link active">
            <i class="fas fa-robot"></i>
            <span class="nav-text">Agents</span>
          </a>
        </div>
      </div>
      <div class="sidebar-bottom-content">
        <div class="sidebar-nav bottom-nav">
          <button class="nav-link theme-toggle-sidebar" data-theme-toggle>
            <i class="fas fa-sun theme-icon-light"></i>
            <i class="fas fa-moon theme-icon-dark"></i>
            <span class="nav-text theme-text">Light Mode</span>
          </button>
        </div>
        <div class="user-info" id="user-info">
          <button class="user-info-button" id="user-info-button">
            <div class="user-avatar">
              <div class="avatar-text">${avatarLetter}</div>
            </div>
            <div class="user-details">
              <span class="username">${user.name}</span>
            </div>
            <i class="fas fa-chevron-down dropdown-icon"></i>
          </button>
          <div class="user-dropdown" id="user-dropdown">
            <a href="/settings" class="dropdown-item">
              <i class="fas fa-cog"></i><span>Settings</span>
            </a>
            <div class="dropdown-divider"></div>
            <form method="POST" action="/auth/logout" style="margin:0;">
              <button type="submit" class="dropdown-item" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;">
                <i class="fas fa-sign-out-alt"></i><span>Logout</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Chat Area (reuses chat.js) -->
    <div class="chat-container">
      <!-- Agent Header -->
      <div class="project-header">
        <div class="project-header-content">
          <div class="project-name-container" style="display:flex;align-items:center;gap:0.5rem;">
            <a href="/projects?tab=agents" style="color:var(--text-secondary);text-decoration:none;">
              <i class="fas fa-arrow-left"></i>
            </a>
            <i class="fas fa-robot" style="color:var(--primary-color);"></i>
            <h1 class="project-name" id="agent-name-display">${agent.name}</h1>
            <span class="agent-status-badge" id="agent-status-badge" style="color:${statusColor};background:${statusColor}15;" title="${statusLabel}">
              <span class="status-dot" style="background:${statusColor};" id="agent-status-dot"></span>
              <span id="agent-status-text">${statusLabel}</span>
            </span>
            ${agent.sandboxUrl ? html`
              <a href="${agent.sandboxUrl}" target="_blank" rel="noopener" style="font-size:0.75rem;color:var(--primary-color);margin-left:0.25rem;" title="Open sandbox URL">
                <i class="fas fa-external-link-alt"></i>
              </a>
            ` : ""}
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <!-- Pause toggle is shown only when the agent has scheduled work
                 to suppress. For unscheduled agents, there's nothing to pause. -->
            <button id="agent-pause-btn" class="btn btn-secondary btn-sm" onclick="togglePauseAgent('${agent.agentId}')" style="display:none;" title="Pause scheduled runs">
              <i class="fas fa-pause"></i> Pause
            </button>
            <button id="artifacts-button" class="artifacts-button" title="Toggle Agent Settings">
              <i class="fas fa-cog"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- Messages (chat.js renders here) -->
      <div class="chat-messages" id="chat-messages">
        <div class="message-container">
          ${agent.conversationId ? html`
            <div class="loading-messages" style="text-align:center;padding:2rem;opacity:0.5;">Loading conversation...</div>
          ` : html`
            <div class="welcome-message">
              <h2>${agent.name === "New Agent" ? "What do you want this agent to do?" : agent.name}</h2>
              <p>${agent.name === "New Agent" ? "Describe a task in plain English. The agent figures out the right tools (Composio, workspace, web search) — you don't need to pick." : "Send a task, or set a schedule in the side panel."}</p>
              ${agent.name === "New Agent" ? html`
                <div class="example-prompts">
                  <button class="example-prompt-card" data-prompt="Analyze a CSV I'll upload — show me schema, summary stats, and an interactive Plotly chart of the most interesting columns.">
                    <i class="fas fa-chart-line"></i>
                    <div>
                      <div class="example-prompt-title">Analyze data</div>
                      <div class="example-prompt-sub">Upload a CSV / Excel → charts &amp; insights</div>
                    </div>
                  </button>
                  <button class="example-prompt-card" data-prompt="Check my Gmail inbox for new emails in the last hour and give me a 3-bullet summary, highlighting anything that needs a reply.">
                    <i class="fas fa-envelope"></i>
                    <div>
                      <div class="example-prompt-title">Triage inbox</div>
                      <div class="example-prompt-sub">Gmail / Outlook summary on demand or on a schedule</div>
                    </div>
                  </button>
                  <button class="example-prompt-card" data-prompt="Find me 25 B2B SaaS founders in the US who'd be good prospects for a developer-tools product. Include name, company, email, LinkedIn.">
                    <i class="fas fa-bullseye"></i>
                    <div>
                      <div class="example-prompt-title">Find leads</div>
                      <div class="example-prompt-sub">Apollo / Hunter / web search + enrichment</div>
                    </div>
                  </button>
                  <button class="example-prompt-card" data-prompt="Run a recurring check every weekday at 9am EST — pull yesterday's signups from my database and post a summary to Slack.">
                    <i class="fas fa-clock"></i>
                    <div>
                      <div class="example-prompt-title">Set up a recurring job</div>
                      <div class="example-prompt-sub">Cron-driven runs — DB query, scrape, summary, etc.</div>
                    </div>
                  </button>
                </div>
              ` : ""}
            </div>
          `}
        </div>
      </div>

      <!-- Input Area (reuses ChatInput component for chat.js compatibility) -->
      ${ChatInput({
        placeholder: agent.name === "New Agent" ? "Describe what this agent should do..." : `Message ${agent.name}...`,
        models,
        selectedModelKey: modelKey,
        selectedRoleKey: "product_analyst",
        roleOptions: [{ key: "product_analyst", label: "Analyst" }],
        showTurboToggle: false,
        turboEnabled: false,
        showMic: true,
      })}
    </div>
  </div>

  <!-- Agent Settings Panel (replaces artifacts panel) -->
  <div class="artifacts-container" id="artifacts-panel">
    <div class="resize-handle" id="resize-handle"></div>
    <div class="artifacts-accent-bar"></div>

    <!-- Tabs Navigation -->
    <div class="artifacts-tabs" style="display:flex;justify-content:space-between;align-items:center;">
      <div style="display:flex;flex-wrap:wrap;">
        <button class="tab-button active" data-tab="settings" onclick="switchTab('settings')">Settings</button>
        <button class="tab-button" data-tab="secrets" onclick="switchTab('secrets')">Secrets</button>
        <button class="tab-button" data-tab="data" onclick="switchTab('data')">Data Room</button>
        <button class="tab-button" data-tab="schedules" onclick="switchTab('schedules')">Schedules</button>
        <button class="tab-button" data-tab="runs" onclick="switchTab('runs')">Runs</button>
        <button class="tab-button" data-tab="state" onclick="switchTab('state')">State</button>
        <button class="tab-button" data-tab="memory" onclick="switchTab('memory')">Memory</button>
      </div>
      <button class="panel-arrow-right" id="artifacts-toggle" style="margin-left:auto;padding:8px;background:none;border:none;color:#ccc;cursor:pointer;">
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>

    <div class="artifacts-content">
      <div class="tab-content">
        <!-- Settings Tab -->
        <div class="tab-pane active" id="settings">
          <div style="padding:20px;">
            <form id="agent-settings-form" onsubmit="handleSaveSettings(event)">
              <div class="form-group">
                <label>Name</label>
                <input type="text" name="name" value="${agent.name}" class="input" />
              </div>
              <div class="form-group">
                <label>Personality</label>
                <textarea name="personality" rows="4" class="input" style="resize:vertical;">${agent.personality ?? ""}</textarea>
              </div>
              <div class="form-group">
                <label>Instructions</label>
                <textarea name="instructions" rows="4" class="input" style="resize:vertical;">${agent.instructions ?? ""}</textarea>
              </div>
              <div class="form-group">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                  <label style="margin:0;">Integrations enabled for this agent</label>
                  <button type="button" id="connectors-btn" class="btn btn-secondary btn-sm" style="font-size:0.75rem;padding:0.3rem 0.625rem;">
                    <i class="fas fa-plus" style="font-size:0.625rem;"></i> Add
                  </button>
                </div>
                ${(() => {
                  // Only show toolkits actually enabled FOR THIS AGENT (not
                  // every user-level connection). The list grows when the
                  // agent calls requestConnectorAuth or when the user adds
                  // one explicitly via the "Add" button.
                  const enabledSet = new Set(agent.composioToolkits ?? []);
                  const enabledToolkits = composioToolkits.filter((t) => enabledSet.has(t.slug));
                  return enabledToolkits.length > 0 ? html`
                    <div style="display:flex;flex-direction:column;gap:0.5rem;">
                      ${enabledToolkits.map((t) => html`
                        <label class="toolkit-switch-row">
                          <span class="toolkit-switch-name">${t.name.toLowerCase()}</span>
                          <span class="toolkit-switch">
                            <input type="checkbox" name="composio_toolkits" value="${t.slug}" checked />
                            <span class="toolkit-switch-track"><span class="toolkit-switch-thumb"></span></span>
                          </span>
                        </label>
                      `)}
                    </div>
                  ` : html`
                    <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0;">None yet. Click <strong>Add</strong> to enable an integration for this agent, or just ask in chat — the agent will request what it needs.</p>
                  `;
                })()}
                <small style="color:var(--text-secondary);font-size:0.7rem;margin-top:0.625rem;line-height:1.45;display:block;">Each agent has its own list. Toggle off to remove access without disconnecting at the account level.</small>
              </div>
              <div class="form-group">
                <label>Run timeout (minutes)</label>
                <input type="number" name="run_timeout_minutes" min="1" max="1440"
                  value="${agent.runTimeoutMs ? Math.round(agent.runTimeoutMs / 60_000) : 30}" class="input" />
                <small style="color:var(--text-secondary);">Wall-clock limit per run. Runs exceeding this are killed and marked as timeout.</small>
              </div>
              <div class="form-group">
                <label>Auto-stop after idle (minutes, 0 = never)</label>
                <input type="number" name="auto_stop_minutes" min="0" max="10080"
                  value="${agent.autoStopAfterIdleMs ? Math.round(agent.autoStopAfterIdleMs / 60_000) : 0}" class="input" />
                <small style="color:var(--text-secondary);">Stops the workspace when idle for this long. Weekly cron jobs can leave this at 0 and use schedule auto-start instead.</small>
              </div>
              ${agent.webhookToken ? html`
                <div class="form-group">
                  <label>Webhook URL</label>
                  <div style="display:flex;gap:0.5rem;align-items:center;">
                    <input type="text" readonly value="/api/agents/webhook/${agent.webhookToken}" class="input" style="flex:1;font-family:monospace;font-size:0.75rem;" />
                    <button type="button" class="btn btn-secondary btn-sm" onclick="copyWebhookUrl()">
                      <i class="fas fa-copy"></i>
                    </button>
                  </div>
                  <small style="color:var(--text-secondary);">POST JSON here (no auth required) to trigger the agent. Payload is exposed to the run.</small>
                </div>
              ` : ""}
              <button type="submit" class="btn btn-primary btn-sm">
                <i class="fas fa-save"></i> Save Settings
              </button>
            </form>
          </div>
        </div>

        <!-- Secrets Tab -->
        <div class="tab-pane" id="secrets">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Secrets / Env Vars</h3>
              <button class="btn btn-primary btn-sm" onclick="showAddSecretForm()">
                <i class="fas fa-plus"></i> Add Secret
              </button>
            </div>
            <p style="color:var(--text-secondary);font-size:0.75rem;margin-bottom:1rem;">
              Injected into the workspace as environment variables at <code>/root/.env</code>. The agent can use these to call any API without a Composio toolkit — e.g. <code>SHOPIFY_TOKEN</code>, <code>GCP_SA_KEY</code>, <code>STRIPE_SECRET</code>.
            </p>
            <div id="add-secret-form" style="display:none;margin-bottom:1rem;padding:1rem;background:var(--bg-secondary);border-radius:var(--radius);border:1px solid var(--border-color);">
              <div class="form-group">
                <label>Key (UPPER_SNAKE_CASE)</label>
                <input type="text" id="secret-key" class="input" placeholder="SHOPIFY_TOKEN" />
              </div>
              <div class="form-group">
                <label>Value</label>
                <textarea id="secret-value" rows="3" class="input" placeholder="Value (or paste a full JSON for service accounts)"></textarea>
              </div>
              <div class="form-group">
                <label>Service (optional)</label>
                <input type="text" id="secret-service" class="input" placeholder="shopify / bigquery / stripe / ..." />
              </div>
              <div class="form-group">
                <label>Description (optional)</label>
                <input type="text" id="secret-description" class="input" placeholder="What is this used for?" />
              </div>
              <div style="display:flex;gap:0.5rem;">
                <button class="btn btn-primary btn-sm" onclick="handleAddSecret()">Save</button>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('add-secret-form').style.display='none'">Cancel</button>
              </div>
            </div>
            <div id="secrets-list">
              <p style="color:var(--text-secondary);font-size:0.875rem;">Loading secrets...</p>
            </div>
          </div>
        </div>

        <!-- Data Room Tab -->
        <div class="tab-pane" id="data">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Data Files</h3>
              <label class="btn btn-primary btn-sm" style="cursor:pointer;">
                <i class="fas fa-upload"></i> Upload
                <input type="file" id="data-file-upload" style="display:none;" onchange="handleFileUpload(event)" />
              </label>
            </div>
            <div id="data-files-list">
              <p style="color:var(--text-secondary);font-size:0.875rem;">Loading files...</p>
            </div>
          </div>
        </div>

        <!-- Schedules Tab -->
        <div class="tab-pane" id="schedules">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Scheduled Tasks</h3>
              <button class="btn btn-primary btn-sm" onclick="showAddScheduleForm()">
                <i class="fas fa-plus"></i> Add Schedule
              </button>
            </div>
            <div id="add-schedule-form" style="display:none;margin-bottom:1rem;padding:1rem;background:var(--bg-secondary);border-radius:var(--radius);border:1px solid var(--border-color);">
              <div class="form-group">
                <label>Name</label>
                <input type="text" id="schedule-name" class="input" placeholder="Daily report" />
              </div>
              <div class="form-group">
                <label>Cron Expression</label>
                <input type="text" id="schedule-cron" class="input" placeholder="0 9 * * *" />
                <small style="color:var(--text-secondary);">min hour day month weekday (e.g., "0 9 * * 1-5" = 9am weekdays)</small>
              </div>
              <div class="form-group">
                <label>Command</label>
                <textarea id="schedule-command" rows="2" class="input" placeholder="Generate daily lead report..."></textarea>
              </div>
              <div style="display:flex;gap:0.5rem;">
                <button class="btn btn-primary btn-sm" onclick="handleAddSchedule()">Save</button>
                <button class="btn btn-secondary btn-sm" onclick="document.getElementById('add-schedule-form').style.display='none'">Cancel</button>
              </div>
            </div>
            <div id="schedules-list">
              <p style="color:var(--text-secondary);font-size:0.875rem;">Loading schedules...</p>
            </div>
          </div>
        </div>

        <!-- Runs Tab -->
        <div class="tab-pane" id="runs">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Recent Runs</h3>
              <button class="btn btn-secondary btn-sm" onclick="loadRuns()">
                <i class="fas fa-sync"></i> Refresh
              </button>
            </div>
            <p style="color:var(--text-secondary);font-size:0.75rem;margin-bottom:1rem;">
              Every time the agent is told to do something — from the chat, a schedule, a webhook, or the initial start — it creates a run here. Check status, timing, and errors.
            </p>
            <div id="runs-list">
              <p style="color:var(--text-secondary);font-size:0.875rem;">Loading runs...</p>
            </div>
          </div>
        </div>

        <!-- State Tab -->
        <div class="tab-pane" id="state">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Structured State</h3>
              <div style="display:flex;gap:0.5rem;">
                <button class="btn btn-secondary btn-sm" onclick="loadState()">
                  <i class="fas fa-sync"></i> Reload
                </button>
                <button class="btn btn-primary btn-sm" onclick="handleSaveState()">
                  <i class="fas fa-save"></i> Save
                </button>
              </div>
            </div>
            <p style="color:var(--text-secondary);font-size:0.75rem;margin-bottom:1rem;">
              Incremental watermarks, last-synced IDs, counters. The agent reads/writes this via <code>curl</code> to <code>/api/v1/cli/agent-state</code>. Must be valid JSON.
            </p>
            <textarea id="state-editor" rows="16" class="input" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:0.8125rem;resize:vertical;">{}</textarea>
          </div>
        </div>

        <!-- Memory Tab -->
        <div class="tab-pane" id="memory">
          <div style="padding:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:0.875rem;font-weight:600;">Agent Memory</h3>
              <div style="display:flex;gap:0.5rem;">
                <button class="btn btn-secondary btn-sm" onclick="handleSyncMemory()">
                  <i class="fas fa-sync"></i> Sync
                </button>
                <button class="btn btn-primary btn-sm" onclick="handleSaveMemory()">
                  <i class="fas fa-save"></i> Save
                </button>
              </div>
            </div>
            ${agent.memoryLastSyncedAt ? html`
              <p style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.5rem;">
                Last synced: ${new Date(agent.memoryLastSyncedAt).toLocaleString()}
              </p>
            ` : ""}
            <textarea id="memory-editor" rows="20" class="input" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:0.8125rem;resize:vertical;">${agent.memoryContent ?? ""}</textarea>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Hidden data for chat.js -->
  <div id="server-data"
       data-user-id="${user.id}"
       data-conversation-id="${agent.conversationId ?? ""}"
       style="display:none;"></div>
  <script>
    window.__WS_PATH__ = '/ws/chat';
    // Agent mode: no project context
    window.__AGENT_MODE__ = true;
  </script>
  <script src="/public/js/marked.min.js"></script>
  <script src="/public/js/markdown-config.js"></script>
  <script src="/public/js/sidebar.js"></script>
  <script src="/public/js/chat.js"></script>
  <script src="/public/js/agents.js"></script>

  <script>
    // Model selector
    document.querySelectorAll('#model-submenu .submenu-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.value;
        await fetch('/api/settings/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelKey: key }),
          credentials: 'include',
        });
        document.querySelectorAll('#model-submenu .submenu-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const label = document.getElementById('current-model-left');
        if (label) label.textContent = btn.querySelector('span').textContent.trim();
      });
    });
    const selectedModelBtn = document.querySelector('#model-submenu .submenu-option.selected');
    if (selectedModelBtn) {
      const label = document.getElementById('current-model-left');
      if (label) label.textContent = selectedModelBtn.querySelector('span').textContent.trim();
    }
    requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('sidebar-minimized-preload')));
  </script>

  <!-- Connectors Modal -->
  <div class="connectors-overlay" id="connectors-overlay">
    <div class="connectors-modal">
      <div class="connectors-header">
        <h3>Connectors</h3>
        <div class="connectors-search-wrap">
          <i class="fas fa-search"></i>
          <input type="text" id="connectors-search" placeholder="Search connectors..." />
        </div>
        <button class="connectors-close" id="connectors-close">&#215;</button>
      </div>
      <p class="connectors-subtitle">Connect your apps and services so the AI can access and act on your data.</p>
      <div class="connectors-tabs">
        <button class="connectors-tab active" data-filter="all">All</button>
        <button class="connectors-tab" data-filter="connected">Connected</button>
        <button class="connectors-tab" data-filter="available">Available</button>
      </div>
      <div id="connectors-grid" class="connectors-grid">
        <div class="connectors-loading">Loading connectors...</div>
      </div>
      <div id="connectors-load-more" style="display:none;text-align:center;padding:1rem;">
        <button class="connectors-load-more-btn">Load more</button>
      </div>
    </div>
  </div>
  <div class="connector-detail-overlay" id="connector-detail-overlay">
    <div class="connector-detail-modal">
      <button class="connectors-close" id="connector-detail-close">&#215;</button>
      <div class="connector-detail-header">
        <img id="connector-detail-logo" src="" alt="" class="connector-detail-logo" />
        <div>
          <h3 id="connector-detail-name"></h3>
          <p id="connector-detail-desc"></p>
        </div>
        <button id="connector-detail-action" class="connector-detail-action-btn">Add connector</button>
      </div>
    </div>
  </div>
  <script src="/public/js/connectors.js"></script>
</body>
</html>`;
}
