// The meeting bot's seat pool: claims, leases, sign-outs. Runs against the shipped migration,
// so it also proves the migration matches the schema.
import { test, expect, mock, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readFileSync } from 'node:fs';

// SQLite keeps these timestamps to the second, so the test lease is a couple of seconds.
process.env.MEETING_SEAT_LEASE_MS = '2000';
delete process.env.MEETING_BOT_WORKSPACE;

const sqlite = new Database(':memory:');
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261115-meeting-bot-seats-sqlite.sql', import.meta.url), 'utf8'));
mock.module('../src/config/db.ts', () => ({ db: drizzle(sqlite) }));

const seats = await import('../src/services/meetings/bot-seats.ts');
const { accessPathOf } = await import('../src/services/sandbox/mags-backend.ts');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { sqlite.exec('DELETE FROM meeting_bot_seat'); });

async function readySeat(account = 'agent@lfg.run') {
  const seat = await seats.addSeat(account);
  await seats.markSignedIn(seat.id, account);
  return seat;
}

test('a server that ran the bot before seats existed keeps its one browser as the first seat', async () => {
  await seats.ensureFirstSeat();
  await seats.ensureFirstSeat();
  const all = await seats.listSeats();
  expect(all.length).toBe(1);
  expect(all[0]!.workspace).toBe('lfg-meeting-bot');
  expect(all[0]!.state).toBe('ready');
});

test('new seats wait for a sign-in before they take calls', async () => {
  await seats.addSeat('agent@lfg.run');
  expect(await seats.claimReadySeat('m1')).toBeNull();
  expect(await seats.noSeatMessage()).toContain('no signed-in browser');
});

test('each call gets its own seat, and no seat is given out twice', async () => {
  for (let i = 0; i < 5; i++) await readySeat();
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => seats.claimReadySeat(`m${i}`)));
  const won = claims.filter(Boolean).map((s) => s!.id);
  expect(won.length).toBe(5);
  expect(new Set(won).size).toBe(5);
  expect(await seats.noSeatMessage()).toBe("All 5 of LFG's meeting bots are in calls right now. Try again in a few minutes.");
});

test('a released seat is free again, and the one that rested longest goes first', async () => {
  const a = await readySeat(); await wait(5);
  const b = await readySeat();
  const first = await seats.claimReadySeat('m1');
  await seats.releaseSeat(first!.id, 'm1');
  const second = await seats.claimReadySeat('m2');
  expect(second!.id).not.toBe(first!.id); // the other seat had not been used yet
  expect([a.id, b.id]).toContain(second!.id);
});

test('a renewed claim holds; a claim whose holder died frees itself', { timeout: 15_000 }, async () => {
  const seat = await readySeat();
  expect((await seats.claimReadySeat('alive'))?.id).toBe(seat.id);
  const stop = seats.holdSeat(seat.id, 'alive');
  await wait(4500);
  expect(await seats.claimReadySeat('other')).toBeNull(); // renewed past two lease lengths
  await stop();
  expect((await seats.claimReadySeat('other'))?.id).toBe(seat.id);

  await seats.releaseSeat(seat.id, 'other');
  await seats.claimReadySeat('crashed'); // never renewed
  await wait(3200);
  expect((await seats.claimReadySeat('next'))?.id).toBe(seat.id);
  expect(await seats.renewSeat(seat.id, 'crashed')).toBe(false); // the dead holder can't take it back
});

test('a seat Google signed out stays out of calls until signed in again', async () => {
  const seat = await readySeat();
  await seats.markSignedOut(seat.id, 'Google signed agent@lfg.run out.');
  expect(await seats.claimReadySeat('m1')).toBeNull();
  expect((await seats.seatById(seat.id))!.lastError).toContain('signed');
  await seats.markSignedIn(seat.id, 'agent@lfg.run');
  expect((await seats.seatById(seat.id))!.lastError).toBeNull();
  expect((await seats.claimReadySeat('m1'))?.id).toBe(seat.id);
});

test('a seat being signed in is not given to a call, and one in a call cannot be signed in or removed', async () => {
  const seat = await readySeat();
  expect(await seats.claimSeat(seat.id, 'sign-in:admin')).not.toBeNull();
  expect(await seats.claimReadySeat('m1')).toBeNull();
  await seats.releaseSeat(seat.id, 'sign-in:admin');
  await seats.claimReadySeat('m1');
  expect(await seats.claimSeat(seat.id, 'sign-in:admin')).toBeNull();
  expect(await seats.removeSeat(seat.id)).toBeNull();
});

test('only a Mags secret path is taken from the debugger URL', () => {
  const secret = 'A'.repeat(43);
  expect(accessPathOf(`wss://abc.apps.mags.run/t/${secret}`)).toBe(`/t/${secret}`);
  expect(accessPathOf(`wss://abc.apps.mags.run/t/${secret}/`)).toBe(`/t/${secret}`);
  expect(accessPathOf('wss://abc.apps.mags.run')).toBe('');
  expect(accessPathOf('wss://abc.apps.mags.run/t/short')).toBe('');
  expect(accessPathOf('wss://abc.apps.mags.run/t/../../x' + secret)).toBe('');
  expect(accessPathOf(undefined)).toBe('');
});
