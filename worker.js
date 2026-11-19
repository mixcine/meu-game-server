import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("GameRoom online!");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const playerId = crypto.randomUUID();

    this.ctx.acceptWebSocket(server, [playerId]);

    server.send(JSON.stringify({ type: "welcome", id: playerId }));

    this.broadcast(JSON.stringify({ type: "playerJoined", id: playerId }), server);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;
      const tags = this.ctx.getTags(socket);
      if (tags.length > 0) {
        server.send(JSON.stringify({ type: "existingPlayer", id: tags[0] }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];
    if (!playerId) return;

    // Repassa qualquer sinal de voz WebRTC para os demais jogadores na sala
    if (data.type === "rtc-offer" || data.type === "rtc-answer" || data.type === "rtc-ice") {
      data.from = playerId;
      this.broadcastPreSerialized(JSON.stringify(data), socket);
      return;
    }

    // Repassa mensagens rápidas para os demais jogadores na sala
    if (data.type === "quickMessage") {
      const rawText = typeof data.message === "string"
        ? data.message
        : (typeof data.text === "string" ? data.text : "");
      const cleanMessage = rawText.trim().slice(0, 120);
      if (!cleanMessage) return;

      const payload = JSON.stringify({
        type: "quickMessage",
        id: playerId,
        from: playerId,
        senderId: playerId,
        message: cleanMessage
      });
      this.broadcastPreSerialized(payload, socket);
      return;
    }

    if (data.type === "move") {
      const update = JSON.stringify({
        type: "playerMove",
        id: playerId,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        z: Number(data.z) || 0,
        rotation: Number(data.rotation) || 0
      });
      this.broadcastPreSerialized(update, socket);
    }
  }

  webSocketClose(socket) {
    const tags = this.ctx.getTags(socket);
    if (tags[0]) this.broadcast(JSON.stringify({ type: "playerLeft", id: tags[0] }), socket);
  }

  webSocketError(socket) {
    const tags = this.ctx.getTags(socket);
    if (tags[0]) this.broadcast(JSON.stringify({ type: "playerLeft", id: tags[0] }), socket);
  }

  broadcastPreSerialized(message, exceptSocket = null) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;
      try { socket.send(message); } catch {}
    }
  }

  broadcast(data, exceptSocket = null) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    this.broadcastPreSerialized(message, exceptSocket);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/game") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Use WebSocket.", { status: 400 });
      }
      const id = env.GAME_ROOM.idFromName("GAME-ROOM-001");
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return new Response("🎮 Servidor multiplayer online!");
  }
};
