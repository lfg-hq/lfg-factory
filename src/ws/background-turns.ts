import type { ServerWebSocket } from 'bun';
import type { WsData, WsConnection } from './types.ts';

// Turn lifetime belongs to the conversation, not the browser connection.
const turns = new Set<BackgroundTurn>();
export class BackgroundTurn {
  assistantMessageId?: string;
  readonly events: string[] = [];
  readonly subscribers = new Set<ServerWebSocket<WsData>>();
  readonly transport: ServerWebSocket<WsData>;
  constructor(readonly owner: WsConnection) {
    this.subscribers.add(owner.ws);
    this.transport = new Proxy(owner.ws, { get: (target, property) => {
      if (property === 'send') return (text: string) => {
        const event = JSON.parse(text);
        if (event.type === 'conversation_created') owner.conversationId = event.conversationId;
        this.events.push(text);
        for (const socket of this.subscribers) {
          try { socket.send(text); } catch { this.subscribers.delete(socket); }
        }
        return text.length;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    turns.add(this);
  }
  finish() { turns.delete(this); this.subscribers.clear(); this.events.length = 0; }
}
export function findBackgroundTurn(userId: string, conversationId?: string) {
  if (!conversationId) return undefined;
  return [...turns].find(turn => turn.owner.userId === userId && turn.owner.conversationId === conversationId);
}
export function detachBackgroundSocket(socket: ServerWebSocket<WsData>) {
  for (const turn of turns) turn.subscribers.delete(socket);
}
