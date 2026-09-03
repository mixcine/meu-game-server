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

    // Aceita o WebSocket usando o modo Hibernation
    this.ctx.acceptWebSocket(server, [playerId]);

    // Envia o ID para o jogador
    server.send(JSON.stringify({
      type: "welcome",
      id: playerId
    }));

    // Informa aos jogadores existentes que um novo jogador entrou
    this.broadcast({
      type: "playerJoined",
      id: playerId
    }, server);

    // Envia ao novo jogador os jogadores que já estavam na sala
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;

      const tags = this.ctx.getTags(socket);

      if (tags.length > 0) {
        server.send(JSON.stringify({
          type: "existingPlayer",
          id: tags[0]
        }));
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

    if (!playerId) return;

    // Movimento do jogador
    if (data.type === "move") {

      const update = JSON.stringify({
        type: "playerMove",
        id: playerId,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        z: Number(data.z) || 0,
        rotation: Number(data.rotation) || 0
      });

      this.broadcast(update, socket);
    }
  }

  webSocketClose(socket) {

    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];

    if (!playerId) return;

    this.broadcast({
      type: "playerLeft",
      id: playerId
    }, socket);
  }

  webSocketError(socket) {
    const tags = this.ctx.getTags(socket);
    const playerId = tags[0];

    if (!playerId) return;

    this.broadcast({
      type: "playerLeft",
      id: playerId
    }, socket);
  }

  broadcast(data, exceptSocket = null) {

    const message =
      typeof data === "string"
        ? data
        : JSON.stringify(data);

    for (const socket of this.ctx.getWebSockets()) {

      if (socket === exceptSocket) continue;

      try {
        socket.send(message);
      } catch {
        // Ignora conexões que já foram encerradas
      }
    }
  }
}


export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    // Endpoint do multiplayer
    if (url.pathname === "/game") {

      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response(
          "O servidor multiplayer está online. Use WebSocket.",
          { status: 400 }
        );
      }

      // Uma sala fixa inicialmente.
      // Depois vamos criar várias salas.
      const id = env.GAME_ROOM.idFromName("GAME-ROOM-001");

      const room = env.GAME_ROOM.get(id);

      return room.fetch(request);
    }

    return new Response(
  "🎮 Servidor multiplayer online! GameRoom ativo."
);
  }
};
