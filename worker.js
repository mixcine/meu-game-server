import { DurableObject } from "cloudflare:workers";

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map(); // Armazena estado completo de cada player
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("GameRoom Engine Online!", { status: 200 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const playerId = crypto.randomUUID();

    // Aceita o WebSocket com suporte a Hibernation do Cloudflare
    this.ctx.acceptWebSocket(server, [playerId]);

    // Registra o player com dados iniciais seguros
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

    // Notifica os demais jogadores que alguém entrou
    this.broadcast(JSON.stringify({ type: "playerJoined", id: playerId }), server);

    // Envia ao novo jogador todos os avatares que já estão na sala com suas posições atuais exatas
    for (const [existingId, data] of this.players.entries()) {
      if (existingId === playerId) continue;
      server.send(JSON.stringify({
        type: "existingPlayer",
        id: existingId,
        x: data.x,
        y: data.y,
        z: data.z,
        rotation: data.rotation
      }));
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

    const player = this.players.get(playerId);
    if (player) {
      player.lastSeen = Date.now();
    }

    // --- REPASSE DE SINALIZAÇÃO WEBRTC (VOZ) ---
    if (data.type === "rtc-offer" || data.type === "rtc-answer" || data.type === "rtc-ice") {
      data.from = playerId;
      this.broadcastPreSerialized(JSON.stringify(data), socket);
      return;
    }

    // --- MOVIMENTAÇÃO INSTANTÂNEA E FLUIDA (Sem teletransporte) ---
    if (data.type === "move") {
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

      // Repassa a posição imediatamente para todos os outros (evita o lag visual e o efeito de "travado/teleportando")
      const update = JSON.stringify({
        type: "playerMove",
        id: playerId,
        x: x,
        y: y,
        z: z,
        rotation: rotation
      });

      this.broadcastPreSerialized(update, socket);
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

    this.broadcast(JSON.stringify({
      type: "playerLeft",
      id: playerId
    }), socket);
  }

  broadcastPreSerialized(message, exceptSocket = null) {
    for (const [id, p] of this.players.entries()) {
      if (p.socket === exceptSocket) continue;
      try {
        p.socket.send(message);
      } catch {
        // Conexão morta ignorada com segurança
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
    return new Response("🎮 Servidor Multiplayer Ativo!");
  }
};
