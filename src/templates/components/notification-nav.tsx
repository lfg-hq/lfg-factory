import { html } from "hono/html";

/** Present on first paint; the inbox script attaches behavior without replacing it. */
export const NotificationNav = () => html`<button id="build-inbox-button" class="nav-link" type="button" aria-label="Notifications" aria-expanded="false" aria-controls="build-inbox"><i class="fas fa-bell" aria-hidden="true"></i><span class="nav-text">Notifications</span><span class="build-unread" hidden></span></button>`;
