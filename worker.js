import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.moveSequence = 0;
    this.playerStates = new Map();
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
    this.playerStates.set(playerId, {
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      micActive: false
    });

    // Informa o próprio jogador
    this.send(server, {
      type: "welcome",
      id: playerId,
      serverTime: Date.now()
    });

    // Informa os jogadores já conectados (com posição e estado do mic)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;

      const tags = this.ctx.getTags(socket);
      if (tags.length > 0) {
        const existingId = tags[0];
        const state = this.playerStates.get(existingId) || {
          x: 0,
          y: 0,
          z: 0,
          rotation: 0,
          micActive: false
        };

        this.send(server, {
          type: "existingPlayer",
          id: existingId,
          x: state.x,
          y: state.y,
          z: state.z,
          rotation: state.rotation,
          micActive: state.micActive
        });
      }
    }

    // Informa os demais jogadores sobre a entrada
    this.broadcast({
      type: "playerJoined",
      id: playerId,
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      micActive: false
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

    // Medição de ping
    if (data.type === "ping") {
      this.send(socket, {
        type: "pong",
        t: data.t,
        serverTime: Date.now()
      });
      return;
    }

    // Estado do microfone (ativado/desativado)
    if (data.type === "micState") {
      const active = Boolean(data.active);
      const currentState = this.playerStates.get(playerId) || {
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        micActive: false
      };
      currentState.micActive = active;
      this.playerStates.set(playerId, currentState);

      this.broadcast({
        type: "micState",
        from: playerId,
        id: playerId,
        active
      }, socket);
      return;
    }

    // Comunicação WebRTC (direcionada ao alvo 'to' quando informado)
    if (
      data.type === "rtc-offer" ||
      data.type === "rtc-answer" ||
      data.type === "rtc-ice"
    ) {
      const payload = {
        ...data,
        from: playerId
      };

      if (typeof data.to === "string" && data.to.length > 0) {
        const targetSockets = this.ctx.getWebSockets(data.to);
        for (const targetSocket of targetSockets) {
          if (targetSocket !== socket) {
            this.send(targetSocket, payload);
          }
        }
      } else {
        this.broadcast(payload, socket);
      }
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

      if (
        Math.abs(x) > 100000 ||
        Math.abs(y) > 100000 ||
        Math.abs(z) > 100000 ||
        Math.abs(rotation) > 100000
      ) {
        return;
      }

      const prevState = this.playerStates.get(playerId) || { micActive: false };
      this.playerStates.set(playerId, {
        x,
        y,
        z,
        rotation,
        micActive: prevState.micActive
      });

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

    const playerId = tags[0];
    this.playerStates.delete(playerId);

    this.broadcast({
      type: "playerLeft",
      id: playerId
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
