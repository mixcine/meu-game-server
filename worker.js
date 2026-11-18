import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
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
    this.sessions.set(server, playerId);

    // Boas-vindas com o ID único
    server.send(JSON.stringify({ type: "welcome", id: playerId }));

    // Notifica os outros jogadores que alguém entrou
    this.broadcast(JSON.stringify({ type: "playerJoined", id: playerId }), server);

    // Informa ao novo jogador sobre os usuários já presentes na sala
    for (const [sock, id] of this.sessions.entries()) {
      if (sock === server) continue;
      server.send(JSON.stringify({ type: "existingPlayer", id: id }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const playerId = this.sessions.get(socket);
    if (!playerId) return;

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    // Roteamento seguro e direto para a sinalização WebRTC (Voz por Proximidade)
    if (data.type === "rtc-offer" || data.type === "rtc-answer" || data.type === "rtc-ice") {
      data.from = playerId;
      if (data.to) {
        for (const [targetSocket, targetId] of this.sessions.entries()) {
          if (targetId === data.to) {
            try { targetSocket.send(JSON.stringify(data)); } catch {}
            break;
          }
        }
      }
      return;
    }

    // Movimentação otimizada com chaves compactas para máxima velocidade na rede
    if (data.type === "move") {
      const payload = JSON.stringify({
        t: "m",
        id: playerId,
        x: Math.round(Number(data.x) * 100) / 100,
        y: Math.round(Number(data.y) * 100) / 100,
        z: Math.round(Number(data.z) * 100) / 100,
        rotation: Math.round(Number(data.rotation) * 100) / 100
      });
      this.broadcastToOthers(payload, socket);
    }
  }

  webSocketClose(socket) {
    const playerId = this.sessions.get(socket);
    if (playerId) {
      this.sessions.delete(socket);
      this.broadcast(JSON.stringify({ type: "playerLeft", id: playerId }));
    }
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  broadcastToOthers(message, exceptSocket) {
    for (const [sock] of this.sessions.entries()) {
      if (sock === exceptSocket) continue;
      try { sock.send(message); } catch {}
    }
  }

  broadcast(message, exceptSocket = null) {
    for (const [sock] of this.sessions.entries()) {
      if (sock === exceptSocket) continue;
      try { sock.send(message); } catch {}
    }
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
    return new Response("🎮 Servidor multiplayer global online!");
  }
};
