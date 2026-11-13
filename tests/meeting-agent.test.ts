// The meeting agent end to end, without a real call, model or network: what is said arrives
// as bot-service deliveries, the chat agent and the call are stand-ins that record what they got.
import { test, expect, mock, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.RECALL_API_KEY = 'test-key';
process.env.APP_URL = 'https://lfg.example.com';
process.env.OPENAI_API_KEY = 'test-openai';
process.env.MEETING_REQUEST_PAUSE_MS = '40';
process.env.RECALL_WEBHOOK_SECRET = '';

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
const recall = await import('../src/services/meetings/recall.ts');
const { requestAfterWakePhrase, spokenText, chatChunks, platformOf } = await import('../src/services/meetings/wake.ts');

const turns: any[] = []; const chat: string[] = []; const spoken: string[] = []; const announced: string[] = []; const bots: any[] = [];
let reply = 'There are four tickets pending.'; let left = 0;
Object.assign(agent.deps, {
  createBot: async (opts: any) => { bots.push(opts); return { id: 'bot-1' }; },
  leaveCall: async () => { left++; },
  sendChat: async (_bot: string, text: string) => { chat.push(text); },
  speak: async () => {},
  speech: async (text: string) => { spoken.push(text); return new ArrayBuffer(4); },
  canSpeak: () => true,
  getBotStatus: async () => ({ status: 'in_call', detail: null }),
  runTurn: async (turn: any) => { turns.push(turn); return reply; },
  announce: async (_o: any, text: string) => { announced.push(text); },
});

const said = (speaker: string, text: string) => ({ event: 'transcript.data', data: { data: { words: text.split(' ').map((t, i) => ({ text: t, start_timestamp: { relative: 12 + i } })), participant: { name: speaker } }, bot: { id: 'bot-1' } } });
const typed = (speaker: string, text: string) => ({ event: 'participant_events.chat_message', data: { data: { participant: { name: speaker }, timestamp: { relative: 30 }, data: { text, to: 'everyone' } } } });
const hear = async (meeting: any, payload: any) => agent.handleMeetingEvent((await agent.meetingForUser(meeting.id, 'u1'))!, recall.parseRealtimeEvent(payload)!);
const settle = async (id: string) => { await new Promise(r => setTimeout(r, 90)); await agent.meetingIdle(id); };
const hidden = (conversationId: string) => sqlite.query(`SELECT content FROM message WHERE conversation_id = ? AND user_role = 'meeting_context'`).all(conversationId).map((r: any) => r.content as string);
let n = 0;
const join = () => agent.startMeeting({ userId: 'u1', projectId: 'proj-public', projectName: 'Invoicing', meetingUrl: `https://meet.google.com/abc-defg-${String(++n).padStart(3, 'h')}` });

beforeEach(() => { turns.length = 0; chat.length = 0; spoken.length = 0; announced.length = 0; bots.length = 0; reply = 'There are four tickets pending.'; });

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
  expect(requestAfterWakePhrase('LFG list open tickets')).toBeNull(); // spoken, the bare name is not enough
});

test('adding the agent starts a bot pointed back at this server and opens a conversation for its owner', async () => {
  const meeting = await join();
  expect(meeting.status).toBe('joining');
  expect(meeting.botId).toBe('bot-1');
  expect(meeting.platform).toBe('google_meet');
  expect(bots[0].webhookUrl).toBe(`https://lfg.example.com/api/meetings/webhook/${meeting.webhookToken}`);
  expect(bots[0].videoSocketUrl).toBe(`wss://lfg.example.com/ws/meeting-video?token=${meeting.webhookToken}`);
  expect(bots[0].greeting).toContain('transcribing this call');
  const conv: any = sqlite.query('SELECT * FROM conversation WHERE id = ?').get(meeting.conversationId!);
  expect(conv.user_id).toBe('u1');
  expect(conv.project_id).toBe('proj-public');
  await expect(agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: meeting.meetingUrl })).rejects.toThrow('already in that call');
  await expect(agent.startMeeting({ userId: 'u1', projectId: null, meetingUrl: 'https://example.com/call' })).rejects.toThrow('Google Meet, Zoom or Microsoft Teams');
});

test('when the bot cannot be started, the person is told and no call or empty chat is left behind', async () => {
  const count = () => [sqlite.query('SELECT count(*) AS n FROM meeting').get(), sqlite.query('SELECT count(*) AS n FROM conversation').get()].map((r: any) => r.n);
  const before = count();
  const createBot = agent.deps.createBot;
  agent.deps.createBot = async () => { throw new Error('Recall POST /bot/ failed (401)'); };
  try { await expect(join()).rejects.toThrow('LFG could not join that call'); } finally { agent.deps.createBot = createBot; }
  expect(count()).toEqual(before);
});

test('a spoken request runs the chat agent with the discussion so far, and the answer goes back to the call', async () => {
  const meeting = await join();
  await hear(meeting, said('Priya', 'We should let customers pay invoices by card.'));
  await hear(meeting, said('Sam', 'Agreed, and refunds need an approval step.'));
  await hear(meeting, said('Priya', 'Hey LFG, create a PRD'));
  await hear(meeting, said('Priya', 'on what we just discussed.')); // the request arrives in two pieces
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
  expect(spoken).toEqual(['There are four tickets pending.']);
  expect(announced).toEqual(['There are four tickets pending.']);
  expect((await agent.meetingForUser(meeting.id, 'u1'))!.status).toBe('in_call');
});

test('the agent is only handed what was said since its last turn, and never its own reply again', async () => {
  const meeting = await join();
  await hear(meeting, said('Priya', 'Hey LFG, how many tickets are pending?'));
  await settle(meeting.id);
  await hear(meeting, said('Sam', 'Four is more than I expected.'));
  await hear(meeting, typed('Sam', '@LFG which one is oldest?'));
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
  await hear(meeting, said('Priya', 'LFG shipped the preview yesterday.'));
  await hear(meeting, said('Sam', 'Hey LFG'));
  await hear(meeting, typed('LFG', '@LFG joined and is transcribing this call.'));
  await settle(meeting.id);
  expect(turns).toHaveLength(0);
  expect(chat).toHaveLength(0);
  expect((await agent.listSegments(meeting.id)).map(s => s.speaker)).toEqual(['Priya', 'Sam']);
});

test('a fresh screen share is attached to the request; a stale one is not', async () => {
  const meeting = await join();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  agent.rememberScreenShare(meeting.id, recall.parseRealtimeEvent({ event: 'video_separate_png.data', data: { data: { buffer: png, type: 'webcam', participant: { name: 'Sam' } } } }) as any);
  await hear(meeting, said('Sam', 'Hey LFG, what am I looking at?'));
  await settle(meeting.id);
  expect(turns[0].files).toEqual([]); // a webcam is not a screen share

  agent.rememberScreenShare(meeting.id, recall.parseRealtimeEvent({ event: 'video_separate_png.data', data: { data: { buffer: png, type: 'screenshare', participant: { name: 'Sam' } } } }) as any);
  await hear(meeting, said('Sam', 'Hey LFG, what does this document mean?'));
  await settle(meeting.id);
  expect(turns[1].files).toHaveLength(1);
  expect(turns[1].files[0].type).toBe('image/png');
  expect(turns[1].message).toContain('screen being shared in the call right now is attached');
  const file: any = sqlite.query('SELECT * FROM chat_file WHERE id = ?').get(turns[1].files[0].id);
  expect(file.conversation_id).toBe(meeting.conversationId);
});

test('when the call ends the agent writes one recap from the transcript, and the meeting is final', async () => {
  const meeting = await join();
  for (const text of ['Card payments go first.', 'Refunds need approval.', 'Sam owns the refund flow.']) await hear(meeting, said('Priya', text));
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
  await hear(meeting, said('Priya', 'Hey LFG, are you still there?')); // late delivery
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
  await hear(meeting, said('Priya', 'Hey LFG, draft the release notes.'));
  await settle(meeting.id);
  expect(chat).toEqual(['On it.', "Sorry, I couldn't finish that. The details are in the LFG conversation for this meeting."]);
  expect(spoken).toHaveLength(0);
});

test('replies are shaped for the call: plain speech, and chat messages that fit the meeting app', () => {
  expect(spokenText('**Done.** I saved `Payments PRD` — see [the doc](https://x.test/doc).\n\n- one\n- two')).toBe('Done. I saved Payments PRD — see the doc. one two');
  const long = spokenText('First sentence here. '.repeat(60));
  expect(long.length).toBeLessThan(680);
  expect(long).toEndWith('The rest is in the meeting chat and in LFG.');
  const chunks = chatChunks('word '.repeat(700), 500);
  expect(chunks).toHaveLength(4);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  expect(chunks[3]).toEndWith('(full answer is in LFG)');
  expect(chatChunks('Short answer.', 500)).toEqual(['Short answer.']);
  expect(platformOf('https://us02web.zoom.us/j/123')).toBe('zoom');
  expect(platformOf('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
  expect(platformOf('https://evil-meet.google.com.example.org/x')).toBe('unknown');
});

test('bot-service details: request body, status mapping and signature checking', () => {
  const body = recall.createBotBody({ meetingId: 'm1', meetingUrl: 'https://meet.google.com/x', botName: 'LFG', webhookUrl: 'https://a/w', videoSocketUrl: 'wss://a/v', greeting: 'hi' });
  expect(body.recording_config.realtime_endpoints).toEqual([
    { type: 'webhook', url: 'https://a/w', events: ['transcript.data', 'participant_events.chat_message'] },
    { type: 'websocket', url: 'wss://a/v', events: ['video_separate_png.data'] },
  ]);
  expect((body.recording_config as any).video_mixed_layout).toBe('gallery_view_v2');
  expect(body.automatic_audio_output.in_call_recording.data.kind).toBe('mp3'); // required for the bot to speak later
  expect(recall.mapStatus('bot.in_waiting_room')).toBe('waiting_room');
  expect(recall.mapStatus('in_call_recording')).toBe('in_call');
  expect(recall.mapStatus('done')).toBe('ended');
  expect(recall.mapStatus('fatal')).toBe('failed');
  expect(recall.mapStatus('breakout_room_opened')).toBeNull();

  const key = Buffer.from('super-secret-key');
  const secret = 'whsec_' + key.toString('base64');
  const sign = (payload: string) => 'v1,' + createHmac('sha256', key).update(`msg_1.1700000000.${payload}`).digest('base64');
  const headers = (signature: string) => new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': '1700000000', 'webhook-signature': signature });
  expect(recall.verifySignature(headers(sign('{"a":1}')), '{"a":1}', secret)).toBe(true);
  expect(recall.verifySignature(headers('v1,old= ' + sign('{"a":1}')), '{"a":1}', secret)).toBe(true); // during secret rotation
  expect(recall.verifySignature(headers(sign('{"a":1}')), '{"a":2}', secret)).toBe(false);
  expect(recall.verifySignature(new Headers(), '{"a":1}', secret)).toBe(false);
  expect(recall.verifySignature(new Headers(), '{"a":1}', '')).toBe(true); // no secret configured: the URL token is the credential
});
