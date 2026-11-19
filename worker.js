
import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.moveSequence = 0;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("GameRoom online!");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const playerId = crypto.randomUUID();

    // Registra o jogador
    this.ctx.acceptWebSocket(server, [playerId]);

    // Informa o próprio jogador
    this.send(server, {
      type: "welcome",
      id: playerId,
      serverTime: Date.now()
    });

    // Informa os jogadores já conectados
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;

      const tags = this.ctx.getTags(socket);

      if (tags.length > 0) {
        this.send(server, {
          type: "existingPlayer",
          id: tags[0]
        });
      }
    }

    // Informa os demais jogadores sobre a entrada
    this.broadcast({
      type: "playerJoined",
      id: playerId
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(socket, message) {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!data || typeof data.type !== "string") return;

    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];

    if (!playerId) return;

    // Comunicação WebRTC
    if (
      data.type === "rtc-offer" ||
      data.type === "rtc-answer" ||
      data.type === "rtc-ice"
    ) {
      data.from = playerId;
      this.broadcast(data, socket);
      return;
    }

    // Mensagens rápidas
    if (data.type === "quickMessage") {
      const rawText =
        typeof data.message === "string"
          ? data.message
          : typeof data.text === "string"
            ? data.text
            : "";

      const cleanMessage = rawText.trim().slice(0, 120);

      if (!cleanMessage) return;

      this.broadcast({
        type: "quickMessage",
        id: playerId,
        from: playerId,
        senderId: playerId,
        message: cleanMessage
      }, socket);

      return;
    }

    // Sincronização de movimento
    if (data.type === "move") {
      const x = Number(data.x);
      const y = Number(data.y);
      const z = Number(data.z);
      const rotation = Number(data.rotation);

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        !Number.isFinite(rotation)
      ) {
        return;
      }

      // Evita coordenadas absurdas ou dados inválidos
      if (
        Math.abs(x) > 100000 ||
        Math.abs(y) > 100000 ||
        Math.abs(z) > 100000 ||
        Math.abs(rotation) > 100000
      ) {
        return;
      }

      const clientTime = Number(data.t);

      const timestamp =
        Number.isFinite(clientTime) &&
        Math.abs(Date.now() - clientTime) < 60000
          ? clientTime
          : Date.now();

      const sequence = ++this.moveSequence;

      this.broadcast({
        type: "playerMove",
        id: playerId,
        x,
        y,
        z,
        rotation,
        t: timestamp,
        seq: sequence,
        serverTime: Date.now()
      }, socket);

      return;
    }
  }

  // Desconexão
  webSocketClose(socket) {
    this.removePlayer(socket);
  }

  webSocketError(socket) {
    this.removePlayer(socket);
  }

  removePlayer(socket) {
    const tags = this.ctx.getTags(socket);

    if (!tags.length) return;

    this.broadcast({
      type: "playerLeft",
      id: tags[0]
    }, socket);
  }

  // Envio individual
  send(socket, data) {
    try {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data));
      }
    } catch {
      // Socket indisponível
    }
  }

  // Transmissão multiplayer
  broadcast(data, exceptSocket = null) {
    const message = JSON.stringify(data);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;

      try {
        if (socket.readyState === 1) {
          socket.send(message);
        }
      } catch {
        // Ignora conexões indisponíveis
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/game") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Use WebSocket.", {
          status: 400
        });
      }

      const id = env.GAME_ROOM.idFromName("GAME-ROOM-001");

      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("🎮 Servidor multiplayer online!");
  }
};
