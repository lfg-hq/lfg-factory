/**
 * Knowledge Base Matcher
 *
 * Scores query terms against the index to find relevant knowledge articles.
 * Used both by the searchKnowledge tool (API mode) and for prompt injection (CLI mode).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface IndexEntry {
  id: string;
  path: string;
  category: "implementation" | "design";
  title: string;
  summary: string;
  keywords: string[];
}

interface MatchResult {
  id: string;
  title: string;
  category: string;
  score: number;
  content: string;
}

interface MatchOptions {
  category?: "implementation" | "design" | "all";
  maxResults?: number;
}

let cachedIndex: IndexEntry[] | null = null;

function loadIndex(): IndexEntry[] {
  if (cachedIndex) return cachedIndex;
  const raw = readFileSync(join(__dirname, "index.json"), "utf-8");
  cachedIndex = JSON.parse(raw) as IndexEntry[];
  return cachedIndex;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function scoreEntry(tokens: string[], entry: IndexEntry): number {
  let score = 0;
  const queryLower = tokens.join(" ");

  for (const keyword of entry.keywords) {
    const kwLower = keyword.toLowerCase();
    // Exact keyword match in query string (handles multi-word keywords like "landing page")
    if (queryLower.includes(kwLower)) {
      score += 3;
      continue;
    }
    // Individual token matches against keyword
    for (const token of tokens) {
      if (kwLower === token) {
        score += 3;
      } else if (kwLower.includes(token) || token.includes(kwLower)) {
        score += 1;
      }
    }
  }

  // Summary word matches (1pt each)
  const summaryWords = tokenize(entry.summary);
  for (const token of tokens) {
    if (summaryWords.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function readArticle(relativePath: string): string {
  try {
    return readFileSync(join(__dirname, relativePath), "utf-8");
  } catch {
    return `[Article not found: ${relativePath}]`;
  }
}

/**
 * Match knowledge articles against a query string.
 * Returns top N articles sorted by relevance score.
 */
export function matchKnowledge(
  query: string,
  opts?: MatchOptions
): MatchResult[] {
  const index = loadIndex();
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const category = opts?.category ?? "all";
  const maxResults = opts?.maxResults ?? 3;

  const scored = index
    .filter((e) => category === "all" || e.category === category)
    .map((entry) => ({
      entry,
      score: scoreEntry(tokens, entry),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return scored.map((r) => ({
    id: r.entry.id,
    title: r.entry.title,
    category: r.entry.category,
    score: r.score,
    content: readArticle(r.entry.path),
  }));
}

/**
 * Match knowledge and format as a prompt-injectable string for CLI mode.
 * Returns empty string if no matches found.
 */
export function matchKnowledgeForPrompt(query: string): string {
  const results = matchKnowledge(query, { maxResults: 3 });
  if (results.length === 0) return "";

  const sections = results.map(
    (r) => `### ${r.title}\n\n${r.content}`
  );

  return `\n## Reference Patterns\n\nThe following knowledge base articles are relevant to this ticket. Use these patterns and best practices as reference:\n\n${sections.join("\n\n---\n\n")}\n`;
}
