import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { marked } from "marked";

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  date: Date | null;
  dateDisplay: string;
  readingMinutes: number;
  contentHtml: string;
}

// marketing/content/blog is three levels up from Node/src/utils
const BLOG_DIR = join(import.meta.dir, "..", "..", "..", "marketing", "content", "blog");

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function parseFrontMatter(raw: string): { metadata: Record<string, string>; body: string } {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) return { metadata: {}, body: raw };

  const metadata: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) metadata[key] = value;
  }

  return { metadata, body: match[2] ?? "" };
}

function estimateReadMinutes(text: string): number {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  return Math.max(1, Math.round(words / 200));
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d: Date | null): string {
  if (!d) return "Undated";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

export function loadBlogPosts(): BlogPost[] {
  let files: string[];
  try {
    files = readdirSync(BLOG_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }

  const posts: BlogPost[] = [];

  for (const file of files) {
    const raw = readFileSync(join(BLOG_DIR, file), "utf-8");
    const { metadata, body } = parseFrontMatter(raw);

    const stem = file.replace(/\.md$/, "");
    const slug = metadata.slug || stem;
    const title =
      metadata.title ||
      stem.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const firstLine = body.trim().split("\n")[0] ?? "";
    const excerpt =
      metadata.excerpt || firstLine.replace(/^#+\s*/, "").slice(0, 180);
    const date = parseDate(metadata.date);
    const readingMinutes = estimateReadMinutes(body);
    const contentHtml = marked.parse(body, { async: false }) as string;

    posts.push({
      slug,
      title,
      excerpt,
      date,
      dateDisplay: formatDate(date),
      readingMinutes,
      contentHtml,
    });
  }

  // Newest first, then alphabetical by title
  posts.sort((a, b) => {
    if (!a.date && !b.date) return a.title.localeCompare(b.title);
    if (!a.date) return 1;
    if (!b.date) return -1;
    const diff = b.date.getTime() - a.date.getTime();
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title);
  });

  return posts;
}

export function getBlogPostBySlug(slug: string): BlogPost | null {
  return loadBlogPosts().find((p) => p.slug === slug) ?? null;
}
