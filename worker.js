import { DurableObject } from "cloudflare:workers";

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.moveSequence = 0;
    this.playerStates = new Map();
    this.tttPlayers = new Map(); // socketId/playerId -> { id, name, mark }
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.winner = null;
    this.draw = false;
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
    this.playerStates.set(playerId, {
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      micActive: false
    });

    this.send(server, {
      type: "welcome",
      id: playerId,
      serverTime: Date.now()
    });

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

  getRoomSnapshot() {
    return {
      players: Array.from(this.tttPlayers.values()),
      board: this.board,
      turn: this.turn,
      winner: this.winner,
      draw: this.draw
    };
  }

  evaluateBoard() {
    for (const [a, b, c] of WIN_LINES) {
      if (this.board[a] && this.board[a] === this.board[b] && this.board[a] === this.board[c]) {
        this.winner = this.board[a];
        return;
      }
    }
    if (this.board.every(cell => cell !== null)) {
      this.draw = true;
    }
  }

  resetMatchIfNeeded() {
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.winner = null;
    this.draw = false;
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

    if (data.type === "ping") {
      this.send(socket, {
        type: "pong",
        t: data.t,
        serverTime: Date.now()
      });
      return;
    }

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

    // Jogo da velha: entrar na sala
    if (data.type === "join-room") {
      const cleanName = typeof data.name === "string" ? data.name.trim().slice(0, 20) : "";
      if (!cleanName) {
        this.send(socket, { type: "join-error", error: "Nome inválido." });
        return;
      }

      if (this.tttPlayers.size >= 2 && !this.tttPlayers.has(playerId)) {
        this.send(socket, { type: "join-error", error: "A sala já está cheia." });
        return;
      }

      const usedMarks = new Set(Array.from(this.tttPlayers.values()).map(p => p.mark));
      const mark = usedMarks.has("X") ? "O" : "X";
      const existingPlayerIds = Array.from(this.tttPlayers.keys()).filter(id => id !== playerId);

      this.tttPlayers.set(playerId, {
        id: playerId,
        name: cleanName,
        mark
      });

      this.send(socket, {
        type: "joined-room",
        id: playerId,
        mark,
        existingPlayerIds
      });

      this.broadcast({
        type: "room-state",
        state: this.getRoomSnapshot()
      });
      return;
    }

    // Jogo da velha: fazer jogada
    if (data.type === "make-move") {
      const index = Number(data.index);
      const player = this.tttPlayers.get(playerId);
      if (!player || this.winner || this.draw) return;
      if (this.tttPlayers.size < 2) return;
      if (player.mark !== this.turn) return;
      if (!Number.isInteger(index) || index < 0 || index > 8 || this.board[index] !== null) return;

      this.board[index] = player.mark;
      this.evaluateBoard();
      if (!this.winner && !this.draw) {
        this.turn = this.turn === "X" ? "O" : "X";
      }

      this.broadcast({
        type: "room-state",
        state: this.getRoomSnapshot()
      });
      return;
    }

    // Jogo da velha: reiniciar partida
    if (data.type === "reset-game") {
      if (!this.tttPlayers.has(playerId)) return;
      this.resetMatchIfNeeded();
      this.broadcast({
        type: "room-state",
        state: this.getRoomSnapshot()
      });
      return;
    }

    // Jogo da velha: sair da sala
    if (data.type === "leave-room") {
      this.removePlayer(socket);
    }
  }

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
    this.tttPlayers.delete(playerId);
    this.resetMatchIfNeeded();

    this.broadcast({
      type: "playerLeft",
      id: playerId
    }, socket);

    this.broadcast({
      type: "room-state",
      state: this.getRoomSnapshot()
    }, socket);
  }

  send(socket, data) {
    try {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data));
      }
    } catch {
      // Socket indisponível
    }
  }

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

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/ice-config") {
      const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

      if (env.TURN_URLS) {
        const urls = String(env.TURN_URLS)
          .split(",")
          .map(u => u.trim())
          .filter(Boolean);

        if (urls.length > 0) {
          const turnServer = { urls };
          if (env.TURN_USERNAME) turnServer.username = String(env.TURN_USERNAME);
          if (env.TURN_CREDENTIAL) turnServer.credential = String(env.TURN_CREDENTIAL);
          iceServers.push(turnServer);
        }
      }

      return new Response(JSON.stringify({ iceServers }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    if (url.pathname === "/game") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Use WebSocket.", {
          status: 400
        });
      }

      const rawRoom = url.searchParams.get("room");
      const roomName = rawRoom && rawRoom.trim()
        ? rawRoom.trim().toUpperCase().slice(0, 32)
        : "GAME-ROOM-001";

      const id = env.GAME_ROOM.idFromName(roomName);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("🎮 Servidor multiplayer online!");
  }
};
