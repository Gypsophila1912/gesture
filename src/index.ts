import { GestureRoom, Env } from "./room";

// Durable Object class must be re-exported from entry point
export { GestureRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket endpoint: /ws or /ws?room=xxx
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") || "default";
      const id = env.GESTURE_ROOM.idFromName(room);
      const stub = env.GESTURE_ROOM.get(id);
      return stub.fetch(request);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};
