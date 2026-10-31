/** The feature branch a ticket's build lands on, e.g. `feature/pro-12-add-login`. */
export function ticketBranchName(ticket: { ticketKey?: string | null; name?: string | null; id: string }): string {
  const slug = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const key = slug(ticket.ticketKey || "");
  const title = slug(ticket.name || "").slice(0, 40).replace(/-+$/g, "");
  return key ? `feature/${key}${title ? `-${title}` : ""}` : `feature/ticket-${ticket.id}`;
}
