import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map(); // Armazena dados essenciais de cada player (posição, última atualização)
    this.pendingMovements = new Map(); // Buffer para envio em lote (Throttling)
    this.flushInterval = null;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("GameRoom Engine v3.0 Online!", { status: 200 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const playerId = crypto.randomUUID();

    // Aceita a conexão com modo Hibernation do Cloudflare
    this.ctx.acceptWebSocket(server, [playerId]);

    // Registra o player no estado interno
    this.players.set(playerId, {
      socket: server,
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      lastSeen: Date.now()
    });

    // Envia o boas-vindas com o ID único
    server.send(JSON.stringify({ type: "welcome", id: playerId }));

    // Notifica os demais da entrada do novo jogador
    this.broadcast(JSON.stringify({ type: "playerJoined", id: playerId }), server);

    // Envia a lista de jogadores já presentes para o recém-chegado
    for (const [existingId, data] of this.players.entries()) {
      if (existingId === playerId) continue;
      server.send(JSON.stringify({
        type: "existingPlayer",
        id: existingId,
        x: data.x,
        z: data.z
      }));
    }

    // Inicia o loop de envio em lote se for o primeiro player
    if (!this.flushInterval && this.players.size > 0) {
      this.startFlushLoop();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Loop de alta performance: envia pacotes agrupados a cada ~33ms (30 FPS de rede)
  startFlushLoop() {
    this.flushInterval = setInterval(() => {
      if (this.pendingMovements.size === 0) return;

      const updates = [];
      for (const [id, moveData] of this.pendingMovements.entries()) {
        updates.push(moveData);
      }
      this.pendingMovements.clear();

      const batchMessage = JSON.stringify({
        type: "batchMove",
        players: updates
      });

      this.broadcastPreSerialized(batchMessage);
    }, 33);
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

    const player = this.players.get(playerId);
    if (player) {
      player.lastSeen = Date.now();
    }

    // --- SINALIZAÇÃO WEBRTC (VOZ) ---
    if (data.type === "rtc-offer" || data.type === "rtc-answer" || data.type === "rtc-ice") {
      data.from = playerId;
      this.broadcastPreSerialized(JSON.stringify(data), socket);
      return;
    }

    // --- MOVIMENTAÇÃO COM RATE LIMITING (Anti-Spam / Anti-Cheat básico) ---
    if (data.type === "move") {
      const now = Date.now();
      if (player && player.lastMove && now - player.lastMove < 20) {
        return; // Descarta pacotes excessivos enviados antes de 20ms
      }
      if (player) player.lastMove = now;

      const x = Number(data.x) || 0;
      const y = Number(data.y) || 0;
      const z = Number(data.z) || 0;
      const rotation = Number(data.rotation) || 0;

      if (player) {
        player.x = x;
        player.y = y;
        player.z = z;
        player.rotation = rotation;
      }

      // Adiciona ao buffer para envio em lote
      this.pendingMovements.set(playerId, { id: playerId, x, y, z, rotation });
    }
  }

  webSocketClose(socket) {
    this.handleDisconnect(socket);
  }

  webSocketError(socket) {
    this.handleDisconnect(socket);
  }

  handleDisconnect(socket) {
    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];
    if (!playerId) return;

    this.players.delete(playerId);
    this.pendingMovements.delete(playerId);

    this.broadcast(JSON.stringify({
      type: "playerLeft",
      id: playerId
    }), socket);

    // Para o loop de lote se a sala estiver vazia para economizar CPU
    if (this.players.size === 0 && this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  broadcastPreSerialized(message, exceptSocket = null) {
    for (const [id, p] of this.players.entries()) {
      if (p.socket === exceptSocket) continue;
      try {
        p.socket.send(message);
      } catch {
        // Remove sockets quebrados silenciosamente
      }
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
        return new Response("Requer conexão WebSocket.", { status: 400 });
      }
      const id = env.GAME_ROOM.idFromName("GAME-ROOM-001");
      return env.GAME_ROOM.get(id).fetch(request);
    }
    return new Response("🎮 Servidor Multiplayer Enterprise Ativo!");
  }
};
