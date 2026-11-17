import { html } from "hono/html";

export interface ChatInputModelOption {
  key: string;
  providerLabel: string;
  requiresPro?: boolean;
  label?: string;
  /** Shorter text for the menu row, when the status line needs the longer label. */
  optionLabel?: string;
  available?: boolean;
}

export interface ChatInputRoleOption {
  key: string;
  label: string;
}

interface ChatInputProps {
  placeholder: string;
  models: ChatInputModelOption[];
  selectedModelKey: string;
  selectedRoleKey?: string;
  roleOptions?: ChatInputRoleOption[];
  showTurboToggle?: boolean;
  turboEnabled?: boolean;
  showMic?: boolean;
  /** "Use my computer for AI" is on: offer the agent's effort levels and show its plan usage. */
  localAgent?: { efforts: string[]; effort: string | null };
}

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function groupModels(models: ChatInputModelOption[]) {
  const grouped: Record<string, ChatInputModelOption[]> = {};
  for (const model of models) {
    if (!grouped[model.providerLabel]) grouped[model.providerLabel] = [];
    grouped[model.providerLabel]!.push(model);
  }
  return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) =>
    Number(b.toLowerCase().includes("subscription")) - Number(a.toLowerCase().includes("subscription"))
  ));
}

export function ChatInput({
  placeholder,
  models,
  selectedModelKey,
  selectedRoleKey = "product_analyst",
  roleOptions = [
    { key: "product_analyst", label: "Analyst" },
    { key: "developer", label: "Developer" },
    { key: "designer", label: "Designer" },
  ],
  showTurboToggle = true,
  turboEnabled = false,
  showMic = true,
  localAgent,
}: ChatInputProps) {
  const groupedModels = groupModels(models);
  const selectedRole =
    roleOptions.find((role) => role.key === selectedRoleKey)?.label ?? "Analyst";
  const selectedModel =
    models.find((model) => model.key === selectedModelKey)?.label ?? selectedModelKey;

  return html`
    <div class="chat-input-container">
      <form id="chat-form">
        <div class="input-wrapper">
          <div class="left-actions">
            <button type="button" id="file-upload-btn" class="action-btn" title="Upload file">
              <i class="fas fa-paperclip"></i>
            </button>
            <input
              type="file"
              id="file-upload-input"
              style="display:none"
              multiple
              accept="image/*,.pdf,.csv,.txt,.md,.docx,.xlsx,.mp3,.mp4,.m4a,.wav,.webm,.json,.js,.ts,.py,.html,.css"
            />

            <button type="button" id="connectors-btn" class="action-btn" title="Connectors">
              <i class="fas fa-plug"></i>
              <span class="connector-badge" id="connector-badge" style="display:none">0</span>
            </button>

            <button type="button" id="settings-btn" class="action-btn settings-btn-styled" title="Settings">
              <i class="fas fa-sliders-h"></i>
            </button>

            <span class="status-indicators">
              <span class="status-item role-status" id="role-status-btn">
                <span id="current-role-left">${selectedRole}</span>
              </span>
              <span class="status-divider">•</span>
              <span class="status-item model-status" id="model-status-btn">
                <span id="current-model-left">${selectedModel}</span>
              </span>
              ${localAgent?.efforts.length ? html`<span class="status-divider">•</span>
              <span class="status-item" id="local-effort-status">${localAgent.effort ? EFFORT_LABELS[localAgent.effort] ?? localAgent.effort : "Default effort"}</span>` : ""}
            </span>
            ${localAgent ? html`<button type="button" id="local-usage-btn" class="local-usage-btn" title="Plan usage on your computer" aria-haspopup="dialog" aria-expanded="false" hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5"/><circle id="local-usage-ring" cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="0 47.12" transform="rotate(-90 10 10)"/></svg>
            </button>
            <div class="local-usage-pop" id="local-usage-pop" role="dialog" aria-label="Plan usage" hidden></div>` : ""}

            <div class="settings-dropdown" id="settings-dropdown">
              <div class="settings-menu">
                <div class="menu-item" data-submenu="role">
                  <i class="fas fa-user-tie"></i><span>Role</span>
                  <i class="fas fa-chevron-right submenu-arrow"></i>
                  <div class="submenu" id="role-submenu">
                    ${roleOptions.map(
                      (role) => html`
                        <button
                          type="button"
                          class="submenu-option${role.key === selectedRoleKey ? " selected" : ""}"
                          data-value="${role.key}"
                        >
                          <span>${role.label}</span><i class="fas fa-check"></i>
                        </button>
                      `
                    )}
                  </div>
                </div>

                <div class="menu-item" data-submenu="model">
                  <i class="fas fa-robot"></i><span>Model</span>
                  <i class="fas fa-chevron-right submenu-arrow"></i>
                  <div class="submenu" id="model-submenu">
                    ${Object.entries(groupedModels).map(
                      ([providerLabel, providerModels]) => html`
                        <div class="submenu-group${providerModels.some((model) => model.available !== false) ? "" : " unavailable"}">${providerLabel}${providerModels.every((model) => model.key.startsWith("chatgpt/") || model.key.startsWith("local/")) ? "" : " · API key"}</div>
                        ${providerModels.map(
                          (model) => html`
                            <button
                              type="button"
                              class="submenu-option${model.key === selectedModelKey ? " selected" : ""}${model.available === false ? " unavailable" : ""}"
                              data-value="${model.key}"
                              data-label="${model.label ?? model.key}"
                              ${model.available === false ? "disabled" : ""}
                              title="${model.available === false ? (model.key.startsWith("chatgpt/") ? "Connect ChatGPT in Settings to use subscription models" : `Add a ${model.providerLabel} API key in Settings to use this model`) : (model.key.startsWith("local/") ? "Runs on your computer with your own sign-in; your plan's limits apply" : model.key.startsWith("chatgpt/") ? "Uses your connected ChatGPT subscription; account limits apply" : "Uses provider API tokens")}"
                            >
                              <span>${model.optionLabel ?? (model.label ?? model.key).replace(/ · Subscription$/, "")}</span>
                              <i class="fas fa-check"></i>
                            </button>
                          `
                        )}
                      `
                    )}
                  </div>
                </div>
                ${localAgent?.efforts.length ? html`
                <div class="menu-item" data-submenu="effort">
                  <i class="fas fa-tachometer-alt"></i><span>Effort</span>
                  <i class="fas fa-chevron-right submenu-arrow"></i>
                  <div class="submenu" id="effort-submenu">
                    ${["", ...localAgent.efforts].map((level) => html`
                      <button type="button" class="submenu-option${(localAgent.effort ?? "") === level ? " selected" : ""}" data-value="${level}" data-label="${level ? EFFORT_LABELS[level] ?? level : "Default effort"}">
                        <span>${level ? EFFORT_LABELS[level] ?? level : "Default"}</span><i class="fas fa-check"></i>
                      </button>`)}
                  </div>
                </div>` : ""}

              </div>
            </div>
          </div>

          <div id="chat-input-box">
            <textarea id="chat-input" placeholder="${placeholder}" rows="2" autofocus></textarea>
          </div>

          <div class="input-actions">
            ${showTurboToggle
              ? html`
                  <div class="turbo-switch-container" title="Turbo mode">
                    <label class="turbo-switch">
                      <input type="checkbox" id="turbo-mode-toggle"${turboEnabled ? " checked" : ""} />
                      <span class="turbo-slider"></span>
                    </label>
                    <span class="turbo-label">Turbo</span>
                  </div>
                `
              : ""}
            ${showMic
              ? html`
                  <button type="button" id="record-audio-btn" class="action-btn" title="Record audio">
                    <i class="fas fa-microphone"></i>
                  </button>
                `
              : ""}
            <button type="submit" id="send-btn" class="action-btn" title="Send">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
      </form>
    </div>
  `;
}
