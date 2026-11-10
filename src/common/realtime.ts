import { EventEmitter } from "node:events";

/**
 * In-process live-update bus. Every admin change and every public action (signup, visit, buy click)
 * is published here; the admin panel receives it through GET /admin/events (Server-Sent Events).
 * Single instance only: with several API instances, move this to Redis pub/sub or MongoDB change streams.
 */
export interface RealtimeEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(0);

export function publish(type: string, data: Record<string, unknown> = {}) {
  const event: RealtimeEvent = { type, at: new Date().toISOString(), data };
  realtimeBus.emit("event", event);
}
