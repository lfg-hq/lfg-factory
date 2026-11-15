// The meeting agent end to end, without a real call, model or network: what is said arrives
// as bot-service deliveries, the chat agent and the call are stand-ins that record what they got.
import { test, expect, mock, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readFileSync } from 'node:fs';

process.env.MAGS_API_TOKEN = 'test-token';
process.env.MEETING_REQUEST_PAUSE_MS = '250'; // generous: a loaded machine must not split a two-part request

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY);
CREATE TABLE conversation(id TEXT PRIMARY KEY NOT NULL, user_id TEXT, title TEXT, project_id TEXT, design_canvas_id TEXT, pinned_at INTEGER, created_at INTEGER DEFAULT (unixepoch()) NOT NULL, updated_at INTEGER DEFAULT (unixepoch()) NOT NULL);
CREATE TABLE message(id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, author_id TEXT, content TEXT NOT NULL, content_if_file TEXT DEFAULT '[]', user_role TEXT DEFAULT 'default', is_partial INTEGER DEFAULT 0 NOT NULL, tool_steps TEXT, activity_trail TEXT, page_previews TEXT, end_reason TEXT, is_voice INTEGER DEFAULT 0 NOT NULL, created_at INTEGER DEFAULT (unixepoch()) NOT NULL, last_updated INTEGER DEFAULT (unixepoch()) NOT NULL);
CREATE TABLE chat_file(id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT, file_path TEXT NOT NULL, original_filename TEXT NOT NULL, file_type TEXT DEFAULT '', file_size INTEGER DEFAULT 0 NOT NULL, uploaded_at INTEGER DEFAULT (unixepoch()) NOT NULL);`);
// The shipped migration creates the meeting tables, so the test also proves it matches the schema.
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261113-meetings-sqlite.sql', import.meta.url), 'utf8'));
mock.module('../src/config/db.ts', () => ({ db: drizzle(sqlite) }));
mock.module('../src/ws/connection-manager.ts', () => ({ broadcastToUser: () => {} }));
mock.module('../src/ws/background-turns.ts', () => ({ findBackgroundTurn: () => null }));

const agent = await import('../src/services/meetings/meeting-agent.ts');
const { requestAfterWakePhrase, chatChunks, platformOf, meetLink } = await import('../src/services/meetings/wake.ts');

const turns: any[] = []; const chat: string[] = []; const announced: string[] = []; const bots: any[] = [];
let reply = 'There are four tickets pending.'; let left = 0; let screen: any = null; let voiceKey: string | null = null; const spoken: string[] = [];
Object.assign(agent.deps, {
  startBot: async (opts: any, handlers: any) => { bots.push({ ...opts, handlers }); return { id: 'bot-' + bots.length }; },
  stopBot: async () => { left++; },
  sendChat: async (_bot: string, text: string) => { chat.push(text); },
  screenshot: async () => screen,
  speak: async (_bot: string, clip: ArrayBuffer) => { spoken.push(new TextDecoder().decode(clip)); },
  voiceKey: async () => voiceKey,
  speech: async (text: string, key: string) => new TextEncoder().encode(`${key}:${text}`).buffer,
  runTurn: async (turn: any) => { turns.push(turn); return reply; },
  announce: async (_o: any, text: string) => { announced.push(text); },
});

const hear = (meeting: any, speaker: string, text: string, kind: 'speech' | 'chat' = 'speech') => agent.handleMeetingEvent(meeting.id, { kind, speaker, text });
const said = (speaker: string, text: string) => [speaker, text] as const;
const typed = (speaker: string, text: string) => [speaker, text, 'chat'] as const;
const settle = async (id: string) => { await new Promise(r => setTimeout(r, 400)); await agent.meetingIdle(id); };
const hidden = (conversationId: string) => sqlite.query(`SELECT content FROM message WHERE conversation_id = ? AND user_role = 'meeting_context'`).all(conversationId).map((r: any) => r.content as string);
let n = 0;
const join = () => agent.startMeeting({ userId: 'u1', projectId: 'proj-public', projectName: 'Invoicing', meetingUrl: `https://meet.google.com/abc-defg-${String(++n).padStart(3, 'h')}` });

beforeEach(() => { turns.length = 0; chat.length = 0; announced.length = 0; bots.length = 0; spoken.length = 0; voiceKey = null; screen = null; reply = 'There are four tickets pending.'; });

test('the wake phrase is recognised however speech-to-text spells it, and only then', () => {
  expect(requestAfterWakePhrase('Hey LFG, create a PRD on what we just discussed')).toBe('create a PRD on what we just discussed');
  expect(requestAfterWakePhrase('so yeah. Hey, L F G. how many tickets are pending?')).toBe('how many tickets are pending?');
  expect(requestAfterWakePhrase('okay L.F.G. what does this document mean')).toBe('what does this document mean');
  expect(requestAfterWakePhrase('Hey elle eff gee summarize that')).toBe('summarize that');
  expect(requestAfterWakePhrase('Hey LFG')).toBe('');
  expect(requestAfterWakePhrase('I think LFG is a great product')).toBeNull();
  expect(requestAfterWakePhrase('hey Alfie, can you share your screen')).toBeNull();
  expect(requestAfterWakePhrase('@LFG list open tickets', true)).toBe('list open tickets');
  expect(requestAfterWakePhrase('LFG: list open tickets', true)).toBe('list open tickets');
  // What real captions produced in the first live call, and how people actually address it:
  expect(requestAfterWakePhrase('Lfg, what project is this?')).toBe('what project is this?');
  expect(requestAfterWakePhrase('A agent which project is this?')).toBe('which project is this?');
  expect(requestAfterWakePhrase('LFG list open tickets')).toBe('list open tickets');
  expect(requestAfterWakePhrase('Agent, hello??', true)).toBe('hello??');
  // Talking about it is not talking to it.
  expect(requestAfterWakePhrase('LFG shipped the preview yesterday.')).toBeNull();
  expect(requestAfterWakePhrase('Agents are everywhere now')).toBeNull();
  // Captions mangle the acronym ("Hey, I love to you" in a real call), so plain words work too.
  expect(requestAfterWakePhrase('Hey agent, how many tickets are pending?')).toBe('how many tickets are pending?');
  expect(requestAfterWakePhrase('Okay, assistant. Summarise that.')).toBe('Summarise that.');
  expect(requestAfterWakePhrase('Hey, I love to you, how many tickets?')).toBeNull();
  expect(requestAfterWakePhrase('our agent called yesterday')).toBeNull();
  expect(requestAfterWakePhrase('agent: list open tickets', true)).toBe('list open tickets');
});

test('adding the agent starts a bot for that call and opens a conversation for its owner', async () => {
  const meeting = await join();
  expect(meeting.status).toBe('joining');
  expect(meeting.botId).toBe('bot-1');
  expect(meeting.platform).toBe('google_meet');
  expect(bots[0].meetingUrl).toBe(meeting.meetingUrl);
  const pasted = await agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: 'https://meet.google.com/meet/pst-edli-nkx?authuser=1&hl=en_GB' });
  expect(pasted.meetingUrl).toBe('https://meet.google.com/pst-edli-nkx'); // however it was copied, the bot opens the plain link
  expect(bots[0].botName).toBe('LFG');
  expect(bots[0].greeting).toContain('taking notes on this call for Invoicing');
  const conv: any = sqlite.query('SELECT * FROM conversation WHERE id = ?').get(meeting.conversationId!);
  expect(conv.user_id).toBe('u1');
  expect(conv.project_id).toBe('proj-public');
  await expect(agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: meeting.meetingUrl })).rejects.toThrow('already in that call');
  await expect(agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: 'https://example.com/call' })).rejects.toThrow('Paste a Google Meet link');
  await expect(agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: 'https://us02web.zoom.us/j/123' })).rejects.toThrow('Zoom and Teams are not supported yet');
});

test('what the bot reports from the call becomes status and transcript', async () => {
  const meeting = await join();
  const { handlers } = bots[0];
  handlers.onStatus('waiting_room', null);
  await new Promise(r => setTimeout(r, 30));
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.status).toBe('waiting_room');
  handlers.onStatus('in_call', null);
  handlers.onSaid({ kind: 'speech', speaker: 'Priya', text: 'Morning everyone.' });
  await settle(meeting.id);
  const now = (await agent.meetingForUser(meeting.id, 'u1'))!;
  expect(now.status).toBe('in_call');
  expect(now.startedAt).toBeTruthy();
  expect((await agent.listSegments(meeting.id)).map(s => `${s.speaker}: ${s.text}`)).toEqual(['Priya: Morning everyone.']);
  handlers.onStatus('failed', 'Someone in the call declined the bot\'s request to join.');
  await new Promise(r => setTimeout(r, 30));
  await agent.meetingIdle(meeting.id);
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.statusDetail).toContain('declined');
});

test('when the bot cannot be started, the person is told and no call or empty chat is left behind', async () => {
  const count = () => [sqlite.query('SELECT count(*) AS n FROM meeting').get(), sqlite.query('SELECT count(*) AS n FROM conversation').get()].map((r: any) => r.n);
  const before = count();
  const startBot = agent.deps.startBot;
  agent.deps.startBot = async () => { throw new Error('browser session did not start'); };
  try { await expect(join()).rejects.toThrow('LFG could not start its meeting browser'); } finally { agent.deps.startBot = startBot; }
  expect(count()).toEqual(before);
});

test('when every bot seat is in a call, the call is refused with the pool\'s reason', async () => {
  const { BotBusyError } = await import('../src/services/meetings/meet-bot.ts');
  const startBot = agent.deps.startBot;
  agent.deps.startBot = async () => { throw new BotBusyError("All 3 of LFG's meeting bots are in calls right now. Try again in a few minutes."); };
  try { await expect(join()).rejects.toThrow('All 3 of'); } finally { agent.deps.startBot = startBot; }
});

test('each call claims its bot seat under its own meeting', async () => {
  const meeting = await join();
  expect(bots.at(-1).holder).toBe(meeting.id);
});

test('a spoken request runs the chat agent with the discussion so far, and the answer goes back to the call', async () => {
  const meeting = await join();
  await hear(meeting, ...said('Priya', 'We should let customers pay invoices by card.'));
  await hear(meeting, ...said('Sam', 'Agreed, and refunds need an approval step.'));
  await hear(meeting, ...said('Priya', 'Hey LFG, create a PRD'));
  await hear(meeting, ...said('Priya', 'on what we just discussed.')); // the request arrives in two pieces
  await settle(meeting.id);

  expect(turns).toHaveLength(1);
  expect(turns[0].message).toBe('Priya, in the meeting: create a PRD on what we just discussed.');
  expect(turns[0].conversationId).toBe(meeting.conversationId);
  expect(turns[0].userId).toBe('u1');
  expect(turns[0].userRole).toBeUndefined(); // the request is a visible message in the owner's chat
  const context = hidden(meeting.conversationId!);
  expect(context).toHaveLength(1);
  expect(context[0]).toContain('Priya: We should let customers pay invoices by card.');
  expect(context[0]).toContain('Sam: Agreed, and refunds need an approval step.');
  expect(context[0]).toContain('Do not start builds');
  expect(chat).toEqual(['On it.', 'There are four tickets pending.']);
  expect(announced).toEqual(['There are four tickets pending.']);
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.status).toBe('in_call');
});

test('the agent is only handed what was said since its last turn, and never its own reply again', async () => {
  const meeting = await join();
  await hear(meeting, ...said('Priya', 'Hey LFG, how many tickets are pending?'));
  await settle(meeting.id);
  await hear(meeting, ...said('Sam', 'Four is more than I expected.'));
  await hear(meeting, ...typed('Sam', '@LFG which one is oldest?'));
  await settle(meeting.id);

  expect(turns.map(t => t.message)).toEqual(['Priya, in the meeting: how many tickets are pending?', 'Sam, in the meeting: which one is oldest?']);
  const context = hidden(meeting.conversationId!);
  expect(context).toHaveLength(2);
  expect(context[1]).toContain('Sam: Four is more than I expected.');
  expect(context[1]).toContain('Sam (typed in meeting chat): @LFG which one is oldest?');
  expect(context[1]).not.toContain('how many tickets are pending');
  expect(context[1]).not.toContain('There are four tickets pending.');
  const segments = await agent.listSegments(meeting.id);
  expect(segments.map(s => s.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(segments.map(s => s.kind)).toEqual(['speech', 'agent', 'speech', 'chat', 'agent']);
});

test('ordinary conversation, the bare name, and the bot\'s own chat messages do not trigger the agent', async () => {
  const meeting = await join();
  await hear(meeting, ...said('Priya', 'LFG shipped the preview yesterday.'));
  await hear(meeting, ...said('Sam', 'Hey LFG'));
  await hear(meeting, ...typed('LFG', '@LFG joined and is taking notes on this call.'));
  await settle(meeting.id);
  expect(turns).toHaveLength(0);
  expect(chat).toHaveLength(0);
  expect((await agent.listSegments(meeting.id)).map(s => s.speaker)).toEqual(['Priya', 'Sam']);
});

test('with spoken replies on for the project, the answer is also said aloud, in plain words; off, it is only typed', async () => {
  const meeting = await join();
  reply = '**Done.** I saved `Payments PRD`, see [the doc](https://x.test/doc).';
  await hear(meeting, ...said('Priya', 'Hey agent, write the PRD.'));
  await settle(meeting.id);
  expect(spoken).toEqual([]); // off by default: nothing is sent to paid text-to-speech
  expect(chat).toEqual(['On it.', reply]);

  voiceKey = 'server-key';
  await hear(meeting, ...said('Priya', 'Hey agent, say that again.'));
  await settle(meeting.id);
  expect(spoken).toEqual(['server-key:Done. I saved Payments PRD, see the doc.']);
  expect(chat.slice(-1)).toEqual([reply]); // still typed in the chat as well

  const speak = agent.deps.speak;
  agent.deps.speak = async () => { throw new Error('microphone unavailable'); };
  try {
    await hear(meeting, ...said('Priya', 'Hey agent, once more.'));
    await settle(meeting.id);
    expect(chat.slice(-1)).toEqual([reply]); // a speech failure never costs the typed answer
  } finally { agent.deps.speak = speak; }
});

test('what is on screen is attached to a request only while someone is presenting', async () => {
  const meeting = await join();
  screen = { jpeg: Buffer.from('ffd8ffe0', 'hex'), presenting: false };
  await hear(meeting, ...said('Sam', 'Hey LFG, what am I looking at?'));
  await settle(meeting.id);
  expect(turns[0].files).toEqual([]); // just faces: nothing worth showing the agent

  screen = { jpeg: Buffer.from('ffd8ffe0', 'hex'), presenting: true };
  await hear(meeting, ...said('Sam', 'Hey LFG, what does this document mean?'));
  await settle(meeting.id);
  expect(turns[1].files).toHaveLength(1);
  expect(turns[1].files[0].type).toBe('image/jpeg');
  expect(turns[1].message).toContain('screen being shared in the call right now is attached');
  const file: any = sqlite.query('SELECT * FROM chat_file WHERE id = ?').get(turns[1].files[0].id);
  expect(file.conversation_id).toBe(meeting.conversationId);
});

test('when the call ends the agent writes one recap from the transcript, and the meeting is final', async () => {
  const meeting = await join();
  for (const text of ['Card payments go first.', 'Refunds need approval.', 'Sam owns the refund flow.']) await hear(meeting, ...said('Priya', text));
  reply = '## Recap\nCard payments first.';
  await agent.setStatus(meeting.id, 'ended', 'call_ended');
  await agent.setStatus(meeting.id, 'ended', 'done');
  await agent.meetingIdle(meeting.id);
  await new Promise(r => setTimeout(r, 20));

  expect(turns).toHaveLength(1);
  expect(turns[0].userRole).toBe('meeting_context'); // the recap prompt is not shown as a user message
  expect(turns[0].message).toContain('has ended');
  expect(hidden(meeting.conversationId!)[0]).toContain('Sam owns the refund flow.');
  expect(announced).toEqual(['## Recap\nCard payments first.']);
  expect(chat).toHaveLength(0); // nobody is left in the call to tell
  const after = (await agent.meetingForUser(meeting.id, 'u1'))!;
  expect(after.status).toBe('ended');
  expect(after.endedAt).toBeTruthy();
  await agent.setStatus(meeting.id, 'in_call', null);
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.status).toBe('ended');
  await hear(meeting, ...said('Priya', 'Hey LFG, are you still there?')); // late delivery
  await settle(meeting.id);
  expect(turns).toHaveLength(1);
});

test('a short call with nothing said gets no recap, and removing the agent leaves the call', async () => {
  const meeting = await join();
  const before = left;
  await agent.leaveMeeting(meeting);
  await agent.meetingIdle(meeting.id);
  expect(left).toBe(before + 1);
  expect(turns).toHaveLength(0);
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.statusDetail).toBe('Removed from the call.');
  expect(await agent.meetingForUser(meeting.id, 'someone-else')).toBeNull();
});

test('when the agent cannot answer, the call is told so instead of hearing nothing', async () => {
  const meeting = await join();
  reply = '';
  await hear(meeting, ...said('Priya', 'Hey LFG, draft the release notes.'));
  await settle(meeting.id);
  expect(chat).toEqual(['On it.', "Sorry, I couldn't finish that. The details are in the LFG conversation for this meeting."]);
});

test('replies fit the meeting chat, and only Google Meet links are recognised as such', () => {
  const chunks = chatChunks('word '.repeat(700), 500);
  expect(chunks).toHaveLength(4);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  expect(chunks[3]).toEndWith('(full answer is in LFG)');
  expect(chatChunks('Short answer.', 500)).toEqual(['Short answer.']);
  expect(platformOf('https://meet.google.com/abc-defg-hij')).toBe('google_meet');
  expect(platformOf('https://evil-meet.google.com.example.org/x')).toBe('unknown');
  expect(meetLink('https://meet.google.com/meet/sjk-komj-tut?authuser=1&hl=en_GB')).toBe('https://meet.google.com/sjk-komj-tut');
  expect(meetLink('https://meet.google.com/SJK-KOMJ-TUT/')).toBe('https://meet.google.com/sjk-komj-tut');
  expect(meetLink('https://meet.google.com/')).toBeNull();
  expect(meetLink('https://meet.google.com/new')).toBeNull();
});

test('a server restart ends calls whose bot is gone, so nothing stays "in the call" forever', async () => {
  const meeting = await join();
  await agent.endOrphanedMeetings();
  await agent.meetingIdle(meeting.id);
  const after = (await agent.meetingForUser(meeting.id, 'u1'))!;
  expect(after.status).toBe('ended');
  expect(after.statusDetail).toBe('LFG restarted during the call.');
});
