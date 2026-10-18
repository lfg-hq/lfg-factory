import { describe, expect, test } from 'bun:test';
import { abortable, cancellableStream, trackTurnTools } from '../src/ai/stream-cancellation.ts';

const never = () => new Promise<never>(() => {});
describe('steering cancellation', () => {
  test('releases a provider read even when next and return ignore abort', async () => {
    const controller = new AbortController();
    const source: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({next: never, return: never}) };
    const read = cancellableStream(source, controller.signal).next();
    controller.abort();
    await expect(read).rejects.toHaveProperty('name', 'AbortError');
  });
  test('does not wait for missing final provider metadata', async () => {
    const controller = new AbortController();
    const response = abortable(never(), controller.signal);
    controller.abort();
    await expect(response).rejects.toHaveProperty('name', 'AbortError');
    await expect(abortable(never(), controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  });
  test('preserves streamed values before cancellation', async () => {
    const controller = new AbortController();
    const stream = cancellableStream((async function* () { yield 'first'; await never(); })(), controller.signal);
    expect(await stream.next()).toEqual({value:'first',done:false});
    const read = stream.next(); controller.abort();
    await expect(read).rejects.toHaveProperty('name','AbortError');
  });
  test('waits for an already running operation and rejects late tool execution', async () => {
    const controller = new AbortController();
    let finish!: () => void; let calls = 0;
    const tracked = trackTurnTools({write:{execute: () => { calls++; return new Promise<void>(resolve => {finish=resolve;}); }}},controller.signal);
    const running = tracked.tools.write.execute();
    await Promise.resolve();
    controller.abort();
    let drained = false;
    const drain = tracked.drain().then(() => {drained=true;});
    await Promise.resolve(); expect(drained).toBe(false);
    await expect(tracked.tools.write.execute()).rejects.toHaveProperty('name','AbortError');
    expect(calls).toBe(1);
    finish(); await running; await drain; expect(drained).toBe(true);
  });
});
