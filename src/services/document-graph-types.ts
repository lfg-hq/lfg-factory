export type GraphKind = "document" | "upload" | "external" | "epic" | "ticket";
export interface GraphNode {
  id: string;
  name: string;
  kind: GraphKind;
  url?: string;
  provider?: string;
  warning?: string;
  hash: string;
  duplicateKey?: string;
}
export interface GraphEdge {
  source: string;
  target: string;
  relation: "related_to" | "relevant_to" | "source_for" | "belongs_to";
  origin: "existing" | "suggested" | "manual";
  reason: string;
  confidence?: number;
}
export interface GraphSnapshot {
  hashes: Record<string, string>;
  edges: GraphEdge[];
}
export interface ReadableGraphNode extends GraphNode { text: string }
export const emptyGraph = (): GraphSnapshot => ({ hashes: {}, edges: [] });
export const edgeKey = (e: { source: string; target: string; relation: string }) => JSON.stringify([e.source, e.target, e.relation]);
