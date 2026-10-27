import { test, expect, mock, beforeEach } from 'bun:test';
// Screenshots the user sends reach the ticket agent as files in its sandbox.
let msgFiles: any[] = [], chat: any[] = [], attached: any[] = [], execs: string[] = [];
const T = (name: string) => ({ name });
const tables = { messages: T('message'), chatFiles: T('chat_file'), attachments: T('attachment') };
const db = {
  select: () => ({ from: (t: any) => ({ where: () => {
    const rows = t === tables.messages ? [{ files: msgFiles }] : t === tables.chatFiles ? chat : attached;
    const p: any = Promise.resolve(rows);
    p.orderBy = () => ({ limit: async () => [...attached].reverse() });
    return p;
  } }) }),
  insert: () => ({ values: async (rows: any[]) => { attached.push(...rows.map(r => ({ ...r, uploadedAt: new Date('2026-10-27T07:30:00Z') }))); } }),
};
mock.module('../src/config/db.ts', () => ({ db }));
mock.module('../src/db/schema/chat.ts', () => ({ messages: tables.messages, chatFiles: tables.chatFiles }));
mock.module('../src/db/schema/tickets.ts', () => ({ projectTicketAttachments: tables.attachments }));
mock.module('drizzle-orm', () => ({ desc: () => 0, eq: () => 0, inArray: () => 0 }));
mock.module('../src/services/ticket-code.ts', () => ({ shellQuote: (s: string) => `'${s}'` }));
mock.module('../src/services/mags.ts', () => ({ execOnWorkspace: async (_w: string, c: string) => { execs.push(c); return { exitCode: 0, output: '' }; } }));
mock.module('../src/services/s3.ts', () => ({ getPresignedGetUrl: async (key: string) => `https://s3.example/${key}?sig=1` }));
const m = await import('../src/services/ticket-images.ts');
beforeEach(() => {
  msgFiles = [{ id: 'img1', type: 'image/png', name: 'Screenshot.png' }, { id: 'doc1', type: 'application/pdf' }];
  chat = [{ id: 'img1', filePath: 's3:uploads/img1.png', originalFilename: 'Screenshot 2026-10-27 at 3.36.39 PM.png', fileType: 'image/png', fileSize: 10 }];
  attached = []; execs = [];
});

test("only the turn's images are picked up", async () => {
  expect(await m.turnImageIds('turn')).toEqual(['img1']);
  expect(await m.turnImageIds(null)).toEqual([]);
});
test('attaching is idempotent', async () => {
  expect(await m.attachTurnImages('ticket-1', 'turn')).toBe(1);
  expect(await m.attachImagesToTicket('ticket-1', ['img1'])).toBe(0);
  expect(attached[0].filePath).toBe('/api/files/img1');
});
test('screenshots are downloaded into the sandbox and listed for the agent', async () => {
  await m.attachTurnImages('ticket-12345678901', 'turn');
  const block = await m.ticketImagesBlock('ticket-12345678901', 'clone-1');
  expect(execs.some(c => c.includes('curl') && c.includes('https://s3.example/uploads/img1.png'))).toBe(true);
  expect(block).toContain('## Screenshots from the user');
  expect(block).toContain('/data/lfg-attachments/ticket-12345/01-Screenshot_2026-10-27_at_3.36.39_PM.png');
});
test('no screenshots, no section', async () => {
  expect(await m.ticketImagesBlock('ticket-1', 'clone-1')).toBe('');
});
