
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

    this.ctx.acceptWebSocket(server, [playerId]);

    // Identificação do jogador
    this.send(server, {
      type: "welcome",
      id: playerId
    });

    // Informa aos jogadores existentes sobre a entrada
    this.broadcast({
      type: "playerJoined",
      id: playerId
    }, server);

    // Informa ao novo jogador quem já está conectado
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

    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];

    if (!playerId || !data || typeof data.type !== "string") {
      return;
    }

    // =====================================
    // WEBRTC - VOZ POR PROXIMIDADE
    // =====================================

    if (
      data.type === "rtc-offer" ||
      data.type === "rtc-answer" ||
      data.type === "rtc-ice"
    ) {
      data.from = playerId;

      this.broadcast(data, socket);
      return;
    }

    // =====================================
    // MENSAGENS RÁPIDAS
    // =====================================

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

    // =====================================
    // MOVIMENTAÇÃO MULTIPLAYER
    // =====================================

    if (data.type === "move") {
      const x = Number(data.x);
      const y = Number(data.y);
      const z = Number(data.z);
      const rotation = Number(data.rotation);

      // Evita coordenadas inválidas
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z) ||
        !Number.isFinite(rotation)
      ) {
        return;
      }

      // Preserva o timestamp original do cliente
      const clientTime = Number(data.t);

      const timestamp = Number.isFinite(clientTime)
        ? clientTime
        : Date.now();

      // Sequência das atualizações
      const sequence = ++this.moveSequence;

      const update = {
        type: "playerMove",
        id: playerId,

        x,
        y,
        z,
        rotation,

        // Importante para a sincronização do HTML
        t: timestamp,
        seq: sequence
      };

      // Envio imediato, sem esperar outros pacotes
      this.broadcast(update, socket);

      return;
    }
  }

  // =====================================
  // DESCONEXÃO
  // =====================================

  webSocketClose(socket) {
    const tags = this.ctx.getTags(socket);

    if (tags.length > 0) {
      this.broadcast({
        type: "playerLeft",
        id: tags[0]
      }, socket);
    }
  }

  webSocketError(socket) {
    const tags = this.ctx.getTags(socket);

    if (tags.length > 0) {
      this.broadcast({
        type: "playerLeft",
        id: tags[0]
      }, socket);
    }
  }

  // =====================================
  // ENVIO INDIVIDUAL
  // =====================================

  send(socket, data) {
    try {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data));
      }
    } catch {}
  }

  // =====================================
  // TRANSMISSÃO MULTIPLAYER
  // =====================================

  broadcast(data, exceptSocket = null) {
    const message = JSON.stringify(data);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exceptSocket) continue;

      try {
        if (socket.readyState === 1) {
          socket.send(message);
        }
      } catch {}
    }
  }
}

// =========================================
// SERVIDOR PRINCIPAL
// =========================================

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
