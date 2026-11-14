// Whiteboards without a browser, model or network: saving and merging what people draw, what a
// second browser is told changed, and the agent drawing on the board through a stand-in model.
import { test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readFileSync } from 'node:fs';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('u1');`);
// The shipped migration creates the tables, so the test also proves it matches the schema.
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261114-whiteboards-sqlite.sql', import.meta.url), 'utf8'));
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261114-whiteboard-links-sqlite.sql', import.meta.url), 'utf8'));
sqlite.exec(`CREATE TABLE model_selection(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, selected_model TEXT NOT NULL DEFAULT 'gpt-5.6-luna', created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
mock.module('../src/config/db.ts', () => ({ db: drizzle(sqlite) }));
// The models this person has keys for: one of them is listed but not usable (a subscription that is not connected).
mock.module('../src/services/available-models.ts', () => ({ availableChatModels: async () => [
  { key: 'claude_fast', label: 'Claude Fast', providerLabel: 'Anthropic', provider: 'anthropic', available: true },
  { key: 'gpt_big', label: 'GPT Big', providerLabel: 'OpenAI', provider: 'openai', available: true },
  { key: 'chatgpt/x', label: 'GPT · Subscription', providerLabel: 'ChatGPT subscription', provider: 'openai', available: false },
] }));

// The API runs for real; only who is signed in, what they may do in a project, and the model are stand-ins.
let who = 'owner';
const ROLES: Record<string, any> = {
  owner: { role: 'owner', permissions: { canEditFiles: true, canManageTickets: true, canChat: true, canInviteMembers: true } },
  viewer: { role: 'viewer', permissions: { canEditFiles: false, canManageTickets: false, canChat: false, canInviteMembers: false } },
  drawer: { role: 'member', permissions: { canEditFiles: true, canManageTickets: false, canChat: false, canInviteMembers: false } },
  inviter: { role: 'member', permissions: { canEditFiles: true, canManageTickets: false, canChat: true, canInviteMembers: true } },
};
let signedIn = true;
mock.module('../src/auth/middleware.ts', () => ({
  requireAuth: async (c: any, next: any) => { c.set('user', { id: 'u1', name: 'Priya' }); await next(); },
  optionalAuth: async (c: any, next: any) => { c.set('user', signedIn ? { id: 'u1', name: 'Priya' } : null); await next(); },
}));
mock.module('../src/auth/project-access.ts', () => ({
  getProjectAccess: async (projectId: string) => (who === 'stranger' || projectId !== 'proj-public' ? null : { project: { id: 'p1', projectId: 'proj-public', name: 'Invoicing' }, ...ROLES[who] }),
}));
let routeModel: any = null;
mock.module('../src/services/app-profile.ts', () => ({ resolveUserModel: async () => { if (!routeModel) throw new Error('No Anthropic API key configured. Please add your API key in Settings → LLM Keys to use this model.'); return { model: routeModel }; } }));

const store = await import('../src/services/whiteboards/store.ts');
const { default: api, sharedBoardsApi: shared } = await import('../src/routes/api/whiteboards.ts');
const { default: sharedPages } = await import('../src/routes/shared-board.ts');
const live = await import('../src/services/whiteboards/live.ts');
const { authorizeBoardSocket } = await import('../src/routes/api/whiteboards.ts');
const agent = await import('../src/services/whiteboards/agent.ts');

const note = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 200, h: 200, text: id, ...extra });
const board = () => store.createBoard('u1', 'proj-public', 'Ideas');
const fresh = async (id: string) => (await store.getBoard(id))!;

test('a new board is empty, titled, and listed for its project only', async () => {
  const b = await board();
  expect(b.title).toBe('Ideas'); expect(b.version).toBe(0); expect(store.readElements(b)).toEqual([]);
  expect((await store.listBoards('proj-public')).some((row) => row.id === b.id)).toBe(true);
  expect(await store.listBoards('another-project')).toEqual([]);
  expect((await store.createBoard('u1', 'proj-public', '   ')).title).toBe('Untitled board');
});

test('saving merges changed elements into the board instead of replacing it', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('a'), note('b')] });
  // A second browser that only knows about its own element must not wipe the first one's.
  const second = await store.applyOps(b.id, { upserts: [note('c')] });
  expect(second.version).toBe(2);
  expect(store.readElements(await fresh(b.id)).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  await store.applyOps(b.id, { upserts: [note('a', { text: 'changed' })], deletes: ['b'] });
  const now = store.readElements(await fresh(b.id));
  expect(now.map((e) => e.id).sort()).toEqual(['a', 'c']);
  expect(now.find((e) => e.id === 'a')!.text).toBe('changed');
});

test('two saves at the same moment both land', async () => {
  const b = await board();
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.applyOps(b.id, { upserts: [note('n' + i)] })));
  const after = await fresh(b.id);
  expect(store.readElements(after).length).toBe(12); expect(after.version).toBe(12);
});

test('a browser is told only what changed since the version it has, and what is gone', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('a'), note('b')] });
  expect(store.changesSince(await fresh(b.id), 1)).toEqual({ version: 1, elements: [], ids: null });
  await store.applyOps(b.id, { upserts: [note('c')], deletes: ['a'] });
  const changes = store.changesSince(await fresh(b.id), 1);
  expect(changes.version).toBe(2);
  expect(changes.elements.map((e) => e.id)).toEqual(['c']);
  expect(changes.ids!.sort()).toEqual(['b', 'c']);
});

test('what a browser sends is reduced to real element fields', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [
    { id: 'ok', type: 'rect', x: 1.23456, y: Infinity, w: '9', text: 'hi', onclick: 'alert(1)', by: 'agent', _born: 5 },
    { id: 'bad-type', type: 'script', x: 0, y: 0 },
    { id: 'img-js', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' },
    { id: 'img-ok', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:image/png;base64,AAAA' },
    { type: 'rect' }, null, 'nope',
  ] });
  const stored = store.readElements(await fresh(b.id));
  expect(stored.map((e) => e.id).sort()).toEqual(['img-ok', 'ok']);
  const ok = stored.find((e) => e.id === 'ok')!;
  expect(ok).toEqual({ id: 'ok', type: 'rect', x: 1.23, text: 'hi', v: 1 });
});

test('only the server decides that the agent made an element', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('mine', { by: 'agent' })] });
  expect(store.readElements(await fresh(b.id))[0]!.by).toBeUndefined();
  await store.applyOps(b.id, { upserts: [note('its')] }, { by: 'agent' });
  // A person editing the agent's element keeps the mark.
  await store.applyOps(b.id, { upserts: [note('its', { text: 'edited' })] });
  expect(store.readElements(await fresh(b.id)).find((e) => e.id === 'its')).toMatchObject({ by: 'agent', text: 'edited' });
});

test('deleting an element frees the arrows and comments attached to it', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('a'), note('b'), { id: 'l', type: 'arrow', x1: 0, y1: 0, x2: 9, y2: 9, from: 'a', to: 'b' }, { id: 'c', type: 'comment', x: 0, y: 0, attach: 'a', thread: [{ author: 'Sam', text: 'why?' }] }] });
  await store.applyOps(b.id, { deletes: ['a'] });
  const now = store.readElements(await fresh(b.id));
  const line = now.find((e) => e.id === 'l')!, comment = now.find((e) => e.id === 'c')!;
  expect(line.from).toBeUndefined(); expect(line.to).toBe('b'); expect(comment.attach).toBeUndefined();
  // They changed, so other browsers hear about it.
  expect(store.changesSince(await fresh(b.id), 1).elements.map((e) => e.id).sort()).toEqual(['c', 'l']);
});

test('saving to a board that is gone fails plainly', async () => {
  await expect(store.applyOps('missing', { upserts: [note('a')] })).rejects.toThrow('Board not found');
});

// ── The agent ──────────────────────────────────────────────────────────
const finish = (kind: 'stop' | 'tool-calls') => ({ type: 'finish', finishReason: { unified: kind, raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
const say = (text: string) => [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finish('stop')];
const call = (name: string, input: unknown) => [{ type: 'tool-call', toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }, finish('tool-calls')];
function scripted(steps: any[][]) {
  const prompts: any[] = [];
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options: any) => {
      prompts.push(options);
      const chunks = steps[Math.min(step++, steps.length - 1)]!;
      return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...chunks], chunkDelayInMs: 0 }) };
    },
  });
  return { model, prompts };
}
const run = async (b: any, message: string, steps: any[][], extra: Record<string, unknown> = {}) => {
  const events: any[] = []; const { model, prompts } = scripted(steps);
  const text = await agent.runBoardAgent({ board: await fresh(b.id), userId: 'u1', message, emit: (e) => events.push(e), model, ...extra } as any);
  return { text, events, prompts, system: JSON.stringify(prompts[0].prompt[0]) };
};

test('asked to sketch something, the agent draws it and the board is saved as it goes', async () => {
  const b = await board();
  const { text, events } = await run(b, 'Sketch a login screen', [
    call('add_elements', { elements: [
      { key: 'title', type: 'text', x: 140, y: 120, text: 'Sign in', fontSize: 28 },
      { key: 'screen', type: 'frame', x: 100, y: 100, w: 390, h: 800, text: 'Login' },
      { key: 'email', type: 'rect', x: 140, y: 200, w: 310, h: 40, text: 'Email', fill: 'white', stroke: 'gray', align: 'left' },
      { key: 'go', type: 'rect', x: 140, y: 260, w: 310, h: 40, text: 'Continue', fill: 'accent', color: 'white', bold: true },
      { type: 'arrow', from: 'email', to: 'go', text: 'then' },
    ] }),
    say('I sketched a login screen in a mobile frame.'),
  ]);
  expect(text).toBe('I sketched a login screen in a mobile frame.');
  const stored = store.readElements(await fresh(b.id));
  expect(stored.map((e) => e.type).sort()).toEqual(['arrow', 'frame', 'rect', 'rect', 'text']);
  expect(stored.every((e) => e.by === 'agent')).toBe(true);
  const frame = stored.find((e) => e.type === 'frame')!, button = stored.find((e) => e.text === 'Continue')!, arrow = stored.find((e) => e.type === 'arrow')!;
  // Palette names become colours, and the frame sits behind what was drawn on it though it was listed second.
  expect(button).toMatchObject({ fill: '#7c3aed', color: '#ffffff', bold: true, radius: 8 });
  expect(stored.every((e) => e === frame || (e.z as number) > (frame.z as number))).toBe(true);
  // The arrow is attached to the elements named by key in the same call.
  expect(arrow.from).toBe(stored.find((e) => e.text === 'Email')!.id); expect(arrow.to).toBe(button.id);
  const ops = events.find((e) => e.type === 'ops');
  expect(ops.upserts.length).toBe(5); expect(ops.version).toBe(1);
  expect(events.at(-1)).toEqual({ type: 'done', text });
});

test('the agent is told what is on the board, what is selected, and where there is room', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('n1', { x: 0, y: 0, text: 'Pay by card' }), note('n2', { x: 300, y: 0, text: 'Refunds need approval' })] });
  const { system } = await run(b, 'What does this mean?', [say('It means refunds wait for a manager.')], { selection: ['n2', 'not-on-board'], viewport: { x: -100, y: -100, w: 1200, h: 700 } });
  expect(system).toContain('- n1 sticky x=0 y=0 w=200 h=200 \\"Pay by card\\"');
  expect(system).toContain('* n2 sticky x=300 y=0 w=200 h=200 \\"Refunds need approval\\"');
  expect(system).toContain('The person has 1 element(s) selected');
  // New work starts clear of the existing notes (they end at x=500).
  expect(system).toContain('Start new work at about x=660, y=0');
  expect(agent.freeOrigin([], { x: 500, y: 400, w: 1000, h: 600 })).toEqual({ x: 580, y: 480 });
});

test('the agent can change and remove what is there, and a later turn remembers the conversation', async () => {
  const b = await board();
  await store.applyOps(b.id, { upserts: [note('n1', { text: 'old' }), note('n2')] });
  const first = await run(b, 'Rename the first note and drop the second', [
    call('update_elements', { updates: [{ id: 'n1', text: 'new', fill: 'pink' }, { id: 'ghost', text: 'x' }] }),
    call('delete_elements', { ids: ['n2'] }),
    say('Renamed it and removed the other.'),
  ]);
  const stored = store.readElements(await fresh(b.id));
  expect(stored.length).toBe(1);
  expect(stored[0]).toMatchObject({ id: 'n1', text: 'new', fill: '#f9a8d4', x: 0, w: 200 });
  expect(first.events.filter((e) => e.type === 'ops').map((e) => e.deletes)).toEqual([[], ['n2']]);
  // The tool told the model which id it could not find.
  expect(JSON.stringify(first.prompts[1].prompt)).toContain('notFound');

  const second = await run(b, 'Thanks', [say('Any time.')]);
  const history = JSON.stringify(second.prompts[0].prompt);
  expect(history).toContain('Rename the first note and drop the second'); expect(history).toContain('Renamed it and removed the other.');
  expect((await store.listMessages(b.id)).map((m) => [m.role, m.content])).toEqual([
    ['user', 'Rename the first note and drop the second'], ['assistant', 'Renamed it and removed the other.'], ['user', 'Thanks'], ['assistant', 'Any time.'],
  ]);
});

test('when the model fails, the question is kept and the error reaches the caller', async () => {
  const b = await board();
  const model = new MockLanguageModelV3({ doStream: async () => { throw new Error('provider down'); } });
  await expect(agent.runBoardAgent({ board: await fresh(b.id), userId: 'u1', message: 'Hello', emit: () => {}, model } as any)).rejects.toThrow('provider down');
  expect((await store.listMessages(b.id)).map((m) => m.role)).toEqual(['user']);
});

// ── Over HTTP: who may do what ─────────────────────────────────────────
const http = (path: string, method = 'GET', body?: unknown) => api.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
const lines = async (response: Response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

test('a project member creates a board, draws on it and reads it back', async () => {
  who = 'owner';
  const created = await (await http('/', 'POST', { projectId: 'proj-public', title: 'Flows' })).json() as any;
  expect(created.board.title).toBe('Flows');
  expect((await http(`/${created.board.id}/ops`, 'POST', { upserts: [note('a')] })).status).toBe(200);
  const opened = await (await http(`/${created.board.id}`)).json() as any;
  expect(opened).toMatchObject({ board: { title: 'Flows', version: 1 }, canEdit: true, canChat: true, messages: [] });
  expect(opened.elements.map((e: any) => e.id)).toEqual(['a']);
  expect(await (await http(`/${created.board.id}?since=0`)).json()).toMatchObject({ version: 1, ids: ['a'], title: 'Flows' });
  expect((await (await http('/?projectId=proj-public')).json() as any).boards.some((b: any) => b.id === created.board.id)).toBe(true);
  expect(await (await http(`/${created.board.id}`, 'PATCH', { title: '  Checkout flows ' })).json()).toEqual({ title: 'Checkout flows' });
});

test('someone who may only view can open a board but not change it or use the agent', async () => {
  who = 'owner';
  const b = await board(); await store.applyOps(b.id, { upserts: [note('a')] });
  who = 'viewer';
  expect(await (await http(`/${b.id}`)).json()).toMatchObject({ canEdit: false, canChat: false });
  for (const [path, method, body] of [[`/${b.id}/ops`, 'POST', { deletes: ['a'] }], [`/${b.id}`, 'PATCH', { title: 'x' }], [`/${b.id}`, 'DELETE', undefined], [`/${b.id}/chat`, 'POST', { message: 'hi' }], ['/', 'POST', { projectId: 'proj-public' }]] as const) {
    expect((await http(path, method, body)).status).toBe(403);
  }
  expect(store.readElements(await fresh(b.id)).length).toBe(1);
  // Someone allowed to draw but not to use the agent keeps drawing; the agent stays off.
  who = 'drawer';
  expect((await http(`/${b.id}/ops`, 'POST', { upserts: [note('b')] })).status).toBe(200);
  expect((await http(`/${b.id}/chat`, 'POST', { message: 'hi' })).status).toBe(403);
});

test('a board in a project you are not in does not exist for you', async () => {
  who = 'owner';
  const b = await board();
  who = 'stranger';
  for (const [path, method] of [[`/${b.id}`, 'GET'], [`/${b.id}?since=0`, 'GET'], [`/${b.id}/ops`, 'POST'], [`/${b.id}/chat`, 'POST'], [`/${b.id}`, 'DELETE'], ['/?projectId=proj-public', 'GET']] as const) {
    expect((await http(path, method, method === 'GET' ? undefined : { message: 'hi', upserts: [note('x')] })).status).toBe(404);
  }
  who = 'owner';
  expect(await store.getBoard(b.id)).not.toBeNull();
});

test('the chat streams what the agent says and draws, one event per line', async () => {
  who = 'owner';
  const b = await board();
  expect((await http(`/${b.id}/chat`, 'POST', { message: '   ' })).status).toBe(400);
  routeModel = scripted([call('add_elements', { elements: [{ type: 'sticky', x: 0, y: 0, text: 'Pay by card' }] }), say('Added a note.')]).model;
  const response = await http(`/${b.id}/chat`, 'POST', { message: 'Add a note about card payments', selection: ['x', 5], viewport: { x: 0, y: 0, w: 1000, h: 600 } });
  expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
  const events = await lines(response);
  expect(events.map((e) => e.type)).toEqual(['ops', 'text', 'text', 'done']);
  expect(events[0].upserts[0]).toMatchObject({ type: 'sticky', text: 'Pay by card', by: 'agent' });
  expect(store.readElements(await fresh(b.id)).length).toBe(1);
  // The board is free again for the next question.
  routeModel = scripted([say('Sure.')]).model;
  expect((await lines(await http(`/${b.id}/chat`, 'POST', { message: 'Thanks' }))).at(-1)).toEqual({ type: 'done', text: 'Sure.' });
  expect((await http(`/${b.id}/messages`, 'DELETE')).status).toBe(200);
  expect(await store.listMessages(b.id)).toEqual([]);
});

test('with no model set up, the chat says what to do instead of failing silently', async () => {
  who = 'owner'; routeModel = null;
  const b = await board();
  const quiet = console.error; console.error = () => {};
  const events = await lines(await http(`/${b.id}/chat`, 'POST', { message: 'Hello' }));
  console.error = quiet;
  expect(events).toEqual([{ type: 'error', message: 'No Anthropic API key configured. Please add your API key in Settings → LLM Keys to use this model.' }]);
});

// ── Sharing a board by link ────────────────────────────────────────────
const guest = (path: string, method = 'GET', body?: unknown) => shared.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });

test('a board is private until someone who can invite people turns its link on', async () => {
  who = 'owner';
  const b = await board(); await store.applyOps(b.id, { upserts: [note('a')] });
  expect((await (await http(`/${b.id}`)).json() as any).share).toEqual({ mode: null, token: null });
  // Being able to draw is not enough to open the board to the outside.
  who = 'drawer';
  expect((await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).status).toBe(403);
  expect((await (await http(`/${b.id}`)).json() as any).share).toBeNull();
  who = 'inviter';
  const link = await (await http(`/${b.id}/share`, 'PUT', { mode: 'view' })).json() as any;
  expect(link.mode).toBe('view'); expect(link.token.length).toBeGreaterThanOrEqual(32);
  expect((await (await http(`/${b.id}`)).json() as any).share).toEqual(link);
  // Someone on the project who may not share it is never shown the link.
  who = 'drawer';
  expect(JSON.stringify(await (await http(`/${b.id}`)).json())).not.toContain(link.token);
});

test('a view link shows the board to someone with no account, and nothing else', async () => {
  who = 'owner';
  const b = await board(); await store.applyOps(b.id, { upserts: [note('a', { text: 'Pay by card' })] });
  await store.addMessage(b.id, 'user', 'a private question to the agent', 'u1');
  const { token } = await (await http(`/${b.id}/share`, 'PUT', { mode: 'view' })).json() as any;
  who = 'stranger';
  const opened = await (await guest(`/${token}`)).json() as any;
  expect(opened).toMatchObject({ board: { title: 'Ideas' }, canEdit: false, canChat: false, messages: [], share: null });
  expect(opened.elements.map((e: any) => e.text)).toEqual(['Pay by card']);
  expect(JSON.stringify(opened)).not.toContain('proj-public');
  expect(await (await guest(`/${token}?since=0`)).json()).toMatchObject({ version: 1, ids: ['a'] });
  // Looking is all a view link allows.
  const refused = await guest(`/${token}/ops`, 'POST', { deletes: ['a'] });
  expect(refused.status).toBe(403); expect((await refused.json() as any).error).toContain('only lets you view');
  expect(store.readElements(await fresh(b.id)).length).toBe(1);
  // The link opens that board only: there is no agent, renaming, deleting or listing behind it.
  for (const [path, method] of [[`/${token}/chat`, 'POST'], [`/${token}`, 'PATCH'], [`/${token}`, 'DELETE'], [`/${token}/share`, 'PUT'], [`/${token}/messages`, 'DELETE'], ['/', 'GET']] as const) {
    expect((await guest(path, method, method === 'GET' ? undefined : { message: 'hi', mode: 'edit', title: 'x' })).status).toBe(404);
  }
  expect(await store.getBoard(b.id)).not.toBeNull();
});

test('an edit link lets a guest draw, and what they send is cleaned like anyone else\'s', async () => {
  who = 'owner';
  const b = await board();
  const { token } = await (await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).json() as any;
  who = 'stranger';
  expect((await (await guest(`/${token}`)).json() as any).canEdit).toBe(true);
  expect((await guest(`/${token}/ops`, 'POST', { upserts: [note('g', { by: 'agent', onclick: 'x' }), { id: 'bad', type: 'script' }] })).status).toBe(200);
  expect(store.readElements(await fresh(b.id))).toEqual([{ id: 'g', type: 'sticky', x: 0, y: 0, w: 200, h: 200, text: 'g', v: 1 }]);
  // Narrowing the link to view-only keeps the same link but stops edits at once.
  who = 'owner';
  expect((await (await http(`/${b.id}/share`, 'PUT', { mode: 'view' })).json() as any).token).toBe(token);
  expect((await guest(`/${token}/ops`, 'POST', { deletes: ['g'] })).status).toBe(403);
});

test('turning the link off kills it for good, and a wrong link opens nothing', async () => {
  who = 'owner';
  const b = await board();
  const first = await (await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).json() as any;
  expect(await (await http(`/${b.id}/share`, 'PUT', { mode: 'anything-else' })).json()).toEqual({ mode: null, token: null });
  expect((await guest(`/${first.token}`)).status).toBe(404);
  expect((await guest(`/${first.token}/ops`, 'POST', { upserts: [note('x')] })).status).toBe(404);
  // Sharing again makes a new link; the one that was turned off stays dead.
  const second = await (await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).json() as any;
  expect(second.token).not.toBe(first.token);
  expect((await guest(`/${first.token}`)).status).toBe(404);
  expect((await guest(`/${second.token}`)).status).toBe(200);
  for (const wrong of ['nope', '', 'null', b.id, second.token.slice(0, -1)]) expect((await guest(`/${wrong}`)).status).toBe(404);
});

test('the link opens the board page for a guest without naming the project', async () => {
  who = 'owner';
  const b = await board();
  const { token } = await (await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).json() as any;
  signedIn = false;
  const page = await sharedPages.request(`/board/${token}`);
  const body = await page.text();
  expect(page.status).toBe(200);
  expect(page.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
  expect(body).toContain(`data-api="/api/shared-boards/${token}"`); expect(body).toContain('data-guest="true"'); expect(body).toContain('data-can-edit="true"'); expect(body).toContain('data-can-chat="false"');
  expect(body).toContain('id="wb-guest"');
  for (const hidden of ['proj-public', 'Invoicing', 'wb-share-btn', '/projects/']) expect(body).not.toContain(hidden);
  // Someone signed in is shown under their own name.
  signedIn = true;
  expect(await (await sharedPages.request(`/board/${token}`)).text()).toContain('data-user="Priya"');
  await store.setShare(b.id, null);
  expect((await sharedPages.request(`/board/${token}`)).status).toBe(404);
});

// ── Live: several people on one board ──────────────────────────────────
function socket() { const got: any[] = []; let closed: number | null = null; return { got, send: (text: string) => { got.push(JSON.parse(text)); }, close: (code?: number) => { closed = code ?? 1000; }, get closed() { return closed; }, of: (t: string) => got.filter((m) => m.t === t) }; }
const enter = (boardId: string, name: string, extra: Record<string, unknown> = {}) => { const s = socket(); const peer = live.joinBoard(s, { boardId, name, canEdit: true, guest: false, ...extra }); return { s, peer }; };
const tell = (peer: any, message: unknown) => live.boardMessage(peer, JSON.stringify(message));

test('people on a board learn who else is there, in distinct colours, and when they leave', async () => {
  const b = await board();
  const a = enter(b.id, 'Priya'), c = enter(b.id, '  Sam   Lee  ');
  expect(a.s.got[0]).toMatchObject({ t: 'welcome', id: a.peer.id, peers: [] });
  expect(c.s.got[0].peers).toEqual([{ id: a.peer.id, name: 'Priya', color: a.peer.color, guest: false }]);
  expect(a.s.of('join')[0].peer).toMatchObject({ id: c.peer.id, name: 'Sam Lee' });
  expect(a.peer.color).not.toBe(c.peer.color);
  expect(live.peersOn(b.id).length).toBe(2);
  // Someone on another board hears none of it.
  const elsewhere = enter((await board()).id, 'Other');
  live.leaveBoard(c.peer);
  expect(a.s.of('leave')).toEqual([{ t: 'leave', id: c.peer.id }]);
  expect(elsewhere.s.got.length).toBe(1);
  live.leaveBoard(a.peer); live.leaveBoard(a.peer); live.leaveBoard(elsewhere.peer);
  expect(live.peersOn(b.id)).toEqual([]);
});

test('cursors, selections and work in progress are passed to the others and never stored', async () => {
  const b = await board();
  const a = enter(b.id, 'Priya'), c = enter(b.id, 'Sam'), viewer = enter(b.id, 'Vic', { canEdit: false });
  tell(a.peer, { t: 'cursor', x: 10.6, y: 20.2 });
  expect(c.s.of('cursor')).toEqual([{ t: 'cursor', id: a.peer.id, x: 11, y: 20 }]);
  expect(a.s.of('cursor')).toEqual([]); // not echoed to the sender
  tell(a.peer, { t: 'select', ids: ['n1', 5, 'n2'] });
  expect(c.s.of('select')[0]).toEqual({ t: 'select', id: a.peer.id, ids: ['n1', 'n2'] });
  tell(a.peer, { t: 'live', els: [note('n1', { x: 50, onclick: 'x' }), { id: 'bad', type: 'script' }], gone: ['draft', 7] });
  expect(c.s.of('live')[0]).toEqual({ t: 'live', id: a.peer.id, els: [{ id: 'n1', type: 'sticky', x: 50, y: 0, w: 200, h: 200, text: 'n1' }], gone: ['draft'] });
  expect(store.readElements(await fresh(b.id))).toEqual([]);
  // Someone who may only view can point and select, but cannot show changes.
  tell(viewer.peer, { t: 'cursor', x: 1, y: 2 }); tell(viewer.peer, { t: 'live', els: [note('n9')] });
  expect(c.s.of('cursor').length).toBe(2); expect(c.s.of('live').length).toBe(1);
  // Nonsense is ignored without disturbing anyone.
  for (const junk of ['not json', '5', 'null', JSON.stringify({ t: 'cursor', x: 'a' }), JSON.stringify({ t: 'ops', upserts: [note('z')] })]) live.boardMessage(a.peer, junk);
  expect(c.s.got.length).toBe(1 + 1 + 4); // welcome, viewer joining, then the four relayed messages above
  expect(store.readElements(await fresh(b.id))).toEqual([]);
  [a, c, viewer].forEach((x) => live.leaveBoard(x.peer));
});

test('a saved change reaches everyone else on the board at once, but not the browser that made it', async () => {
  who = 'owner';
  const b = await board();
  const a = enter(b.id, 'Priya'), c = enter(b.id, 'Sam');
  const saved = await api.request(`/${b.id}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Client': a.peer.id }, body: JSON.stringify({ upserts: [note('n1')] }) });
  expect(await saved.json()).toEqual({ version: 1 });
  expect(a.s.of('ops')).toEqual([]);
  expect(c.s.of('ops')).toEqual([{ t: 'ops', version: 1, by: a.peer.id, deletes: [], upserts: [{ ...note('n1'), v: 1 }] }]);
  // What the agent draws reaches both, and a rename reaches the other.
  routeModel = scripted([call('add_elements', { elements: [{ type: 'sticky', text: 'From LFG' }] }), say('Added.')]).model;
  await (await api.request(`/${b.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Client': a.peer.id }, body: JSON.stringify({ message: 'Add a note' }) })).text();
  expect(a.s.of('ops')).toEqual([]); expect(c.s.of('ops').length).toBe(2); // the asker gets the agent's work on the chat stream instead
  expect(c.s.of('ops')[1].upserts[0]).toMatchObject({ text: 'From LFG', by: 'agent' });
  expect(c.s.of('chat')).toEqual([{ t: 'chat', name: 'Priya', message: 'Add a note', reply: 'Added.' }]);
  expect(a.s.of('chat')).toEqual([]);
  await api.request(`/${b.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Board-Client': a.peer.id }, body: JSON.stringify({ title: 'Renamed' }) });
  expect(c.s.of('title')).toEqual([{ t: 'title', title: 'Renamed' }]); expect(a.s.of('title')).toEqual([]);
  [a, c].forEach((x) => live.leaveBoard(x.peer));
});

test('who may join a board live: members by sign-in, guests by a link that is on', async () => {
  who = 'owner';
  const b = await board();
  const q = (text: string) => new URLSearchParams(text);
  const me = { id: 'u1', name: 'Priya' };
  expect(await authorizeBoardSocket(q(`board=${b.id}`), me)).toEqual({ boardId: b.id, name: 'Priya', canEdit: true, guest: false });
  expect(await authorizeBoardSocket(q(`board=${b.id}`), null)).toBeNull();
  expect(await authorizeBoardSocket(q('board=missing'), me)).toBeNull();
  who = 'viewer';
  expect((await authorizeBoardSocket(q(`board=${b.id}`), me))!.canEdit).toBe(false);
  who = 'stranger';
  expect(await authorizeBoardSocket(q(`board=${b.id}`), me)).toBeNull();
  who = 'owner';
  const { token } = await store.setShare(b.id, 'view');
  expect(await authorizeBoardSocket(q(`token=${token}&name=Dana`), null)).toEqual({ boardId: b.id, name: 'Dana', canEdit: false, guest: true });
  await store.setShare(b.id, 'edit');
  expect(await authorizeBoardSocket(q(`token=${token}`), null)).toEqual({ boardId: b.id, name: 'Guest', canEdit: true, guest: true });
  expect(await authorizeBoardSocket(q('token=wrong-wrong-wrong-wrong'), null)).toBeNull();
});

test('guests are kept out of the agent conversation, choose their own name, and leave when the link changes', async () => {
  who = 'owner';
  const b = await board();
  await (await http(`/${b.id}/share`, 'PUT', { mode: 'edit' })).json();
  const member = enter(b.id, 'Priya'), guestPeer = enter(b.id, 'Guest', { guest: true });
  tell(guestPeer.peer, { t: 'name', name: 'Dana' }); tell(member.peer, { t: 'name', name: 'Not Priya' });
  expect(member.s.of('name')).toEqual([{ t: 'name', id: guestPeer.peer.id, name: 'Dana' }]);
  expect(guestPeer.s.of('name')).toEqual([]); // a member's name is their account's
  routeModel = scripted([say('Private answer.')]).model;
  await (await http(`/${b.id}/chat`, 'POST', { message: 'A private question' })).text();
  expect(member.s.of('chat').length).toBe(1); expect(guestPeer.s.of('chat')).toEqual([]);
  // Narrowing or turning off the link sends guests back to load the page; members stay.
  await http(`/${b.id}/share`, 'PUT', { mode: 'view' });
  expect(guestPeer.s.closed).toBe(live.ACCESS_CHANGED); expect(member.s.closed).toBeNull();
  expect(member.s.of('leave')).toEqual([{ t: 'leave', id: guestPeer.peer.id }]);
  // Saving the same setting again disturbs nobody.
  const again = enter(b.id, 'Guest', { guest: true, canEdit: false });
  await http(`/${b.id}/share`, 'PUT', { mode: 'view' });
  expect(again.s.closed).toBeNull();
  live.leaveBoard(member.peer); live.leaveBoard(again.peer);
});

test('the board chat lists the models this person can use and which one is picked', async () => {
  who = 'owner';
  const b = await board();
  const opened = await (await http(`/${b.id}`)).json() as any;
  // Only usable models are offered; with no usable pick yet, none is marked.
  expect(opened.models).toEqual([{ key: 'claude_fast', label: 'Claude Fast', provider: 'Anthropic' }, { key: 'gpt_big', label: 'GPT Big', provider: 'OpenAI' }]);
  expect(opened.model).toBeNull();
  sqlite.exec(`INSERT INTO model_selection(id, user_id, selected_model) VALUES ('s1', 'u1', 'gpt_big')`);
  expect((await (await http(`/${b.id}`)).json() as any).model).toBe('gpt_big');
  // People who cannot use the agent here are not shown models at all.
  who = 'drawer';
  expect(await (await http(`/${b.id}`)).json()).toMatchObject({ models: [], model: null });
});
