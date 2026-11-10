import { Router } from "express";
import { realtimeBus, type RealtimeEvent } from "../../common/realtime";
import { Session } from "../auth/session.model";
import { env } from "../../config/env";

const HEARTBEAT_MS = 25_000;

/**
 * GET /admin/events — live stream for the admin panel (Server-Sent Events).
 * Auth: the admin session (cookie gsta_admin, or Bearer). The stream ends when the session expires
 * or goes idle, so an open tab cannot keep an admin logged in forever.
 */
export const realtimeRouter = Router();

realtimeRouter.get("/", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n: connected\n\n");

  const onEvent = (e: RealtimeEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  realtimeBus.on("event", onEvent);

  const sessionId = req.sessionId;
  const cleanup = () => {
    clearInterval(timer);
    realtimeBus.off("event", onEvent);
  };
  const timer = setInterval(async () => {
    // Heartbeat without refreshing the session: only real admin activity keeps it alive.
    const s = sessionId ? await Session.findById(sessionId).lean() : null;
    const idle = !s || Date.now() - new Date(s.lastActiveAt).getTime() > env.SESSION_IDLE_MINUTES * 60_000 || s.expiresAt < new Date();
    if (idle) {
      res.write("event: session-expired\ndata: {}\n\n");
      cleanup();
      res.end();
      return;
    }
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  req.on("close", cleanup);
});
