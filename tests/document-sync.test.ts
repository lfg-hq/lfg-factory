import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider push functions are pure apart from the injected executor, so no
// database is touched here; point the driver at a throwaway file anyway.
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "lfg-docsync-")), "test.db");
const { SYNC_PROVIDERS, syncProvider } = await import("../src/services/document-sync.ts");

function recorder(responses: Record<string, Record<string, unknown>>) {
  const calls: { slug: string; args: Record<string, any> }[] = [];
  const exec = async (slug: string, args: Record<string, unknown>) => { calls.push({ slug, args }); return responses[slug] ?? {}; };
  return { calls, exec };
}
const base = { title: "Shop — PRD", fileName: "Shop — PRD.md", markdown: "# PRD\n\nLine<br>", remoteId: null as string | null };

test("every provider has a unique key and Composio toolkit", () => {
  expect(new Set(SYNC_PROVIDERS.map((p) => p.key)).size).toBe(SYNC_PROVIDERS.length);
  expect(syncProvider("notion")?.name).toBe("Notion");
});

test("Notion creates under the parent parsed from a page URL, then replaces content", async () => {
  const notion = syncProvider("NOTION")!;
  const { calls, exec } = recorder({ NOTION_CREATE_NOTION_PAGE: { id: "page-1", url: "https://www.notion.so/page1" } });
  const created = await notion.push({ ...base, exec, destination: "https://www.notion.so/Team/Specs-0123456789abcdef0123456789abcdef" });
  expect(calls[0].args).toMatchObject({ parent_id: "0123456789abcdef0123456789abcdef", title: base.title, markdown: base.markdown });
  expect(created).toMatchObject({ remoteId: "page-1", remoteUrl: "https://www.notion.so/page1" });
  await notion.push({ ...base, exec, destination: "x", remoteId: "page-1" });
  expect(calls[1]).toMatchObject({ slug: "NOTION_UPDATE_PAGE_MARKDOWN", args: { page_id: "page-1", type: "replace_content", replace_content: { new_str: base.markdown } } });
});

test("Google Docs finds a nested document id", async () => {
  const docs = syncProvider("GOOGLEDOCS")!;
  const { calls, exec } = recorder({ GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: { document: { documentId: "doc-9" } } });
  const created = await docs.push({ ...base, exec, destination: "" });
  expect(calls[0].args).toEqual({ title: base.title, markdown_text: base.markdown });
  expect(created.remoteUrl).toBe("https://docs.google.com/document/d/doc-9/edit");
  await docs.push({ ...base, exec, destination: "", remoteId: "doc-9" });
  expect(calls[1]).toEqual({ slug: "GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN", args: { id: "doc-9", markdown: base.markdown } });
});

test("Google Drive takes a folder URL and edits the same file later", async () => {
  const drive = syncProvider("GOOGLEDRIVE")!;
  const { calls, exec } = recorder({ GOOGLEDRIVE_CREATE_FILE_FROM_TEXT: { id: "file-3" } });
  await drive.push({ ...base, exec, destination: "https://drive.google.com/drive/folders/1AbC_d-E" });
  expect(calls[0].args).toMatchObject({ parent_id: "1AbC_d-E", file_name: base.fileName, mime_type: "text/markdown" });
  await drive.push({ ...base, exec, destination: "", remoteId: "file-3" });
  expect(calls[1]).toMatchObject({ slug: "GOOGLEDRIVE_EDIT_FILE", args: { file_id: "file-3", content: base.markdown } });
});

test("Confluence receives XHTML storage format", async () => {
  const confluence = syncProvider("CONFLUENCE")!;
  const { calls, exec } = recorder({ CONFLUENCE_CREATE_PAGE: { id: "77", version: { number: 1 }, _links: { base: "https://acme.atlassian.net/wiki", webui: "/spaces/ENG/pages/77" } } });
  const created = await confluence.push({ ...base, exec, destination: " ENG " });
  const body = calls[0].args.body.storage;
  expect(calls[0].args.spaceId).toBe("ENG");
  expect(body.representation).toBe("storage");
  expect(body.value).toContain("<h1>PRD</h1>");
  expect(body.value).not.toMatch(/<br>/);
  expect(created).toMatchObject({ remoteId: "77", remoteUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/77", remoteVersion: 1 });
});

test("Coda accepts a doc URL", async () => {
  const coda = syncProvider("CODA")!;
  const { calls, exec } = recorder({ CODA_CREATE_A_PAGE: { id: "canvas-1" } });
  await coda.push({ ...base, exec, destination: "https://coda.io/d/Team-Wiki_dAbC123/Home" });
  expect(calls[0].args).toMatchObject({ docId: "AbC123", pageContent: { type: "canvas", canvasContent: { format: "markdown" } } });
});
