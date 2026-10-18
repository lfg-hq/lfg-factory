import { createHash } from "node:crypto";
import { z } from "zod";
import type { GraphEdge, ReadableGraphNode } from "./document-graph-types.ts";
export const graphHash = (value: string) => createHash("sha256").update(value).digest("hex");
const output = z.object({ links: z.array(z.object({
  target: z.string(), relation: z.enum(["related_to", "relevant_to", "source_for"]),
  reason: z.string().min(1).max(400), confidence: z.number().min(0).max(1),
})).max(12) });
export function validateGraphSuggestions(raw: string, source: ReadableGraphNode, candidates: ReadableGraphNode[]): GraphEdge[] {
  const parsed = output.parse(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
  const allowed = new Map(candidates.map(n => [n.id, n]));
  const seen = new Set<string>();
  return parsed.links.filter(link => {
    const target = allowed.get(link.target);
    if (!target || target.id === source.id || link.confidence < 0.75 || seen.has(link.target)) return false;
    if (link.relation === "relevant_to" && target.kind !== "epic") return false;
    seen.add(link.target); return true;
  }).map(link => ({ source: source.id, ...link, origin: "suggested" }));
}
// Rank candidates locally; the small model only receives bounded excerpts.
export function graphCandidates(source: ReadableGraphNode, nodes: ReadableGraphNode[]): ReadableGraphNode[] {
  const terms = new Set((source.name + " " + source.text.slice(0, 6000)).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return nodes.filter(n => n.id !== source.id).map(n => ({ n, score: [...new Set((n.name + " " + n.text.slice(0, 6000)).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].filter(t => terms.has(t)).length }))
    .sort((a,b) => b.score-a.score || a.n.id.localeCompare(b.n.id)).slice(0,24).map(x => x.n);
}
