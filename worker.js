var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 5;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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

const DEFAULT_METERED_USERNAME = "1176eedd6d74aa647f55129f";
const DEFAULT_METERED_CREDENTIAL = "ui23lTtzXzs+S9Iq";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function normalizeRegion(value) {
  const region = String(value || "BR").trim().toUpperCase();
  return region === "EU" ? "EU" : "BR";
}

function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => ROOM_CODE_CHARS[byte % ROOM_CODE_CHARS.length]).join("");
}

function safeRoomName(value) {
  return typeof value === "string" ? value.trim().slice(0, 32) : "";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export class LobbyManager extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const rooms = await ctx.storage.get("rooms");
      this.rooms = rooms && typeof rooms === "object" ? rooms : {};
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/internal/room" && request.method === "GET") {
      const code = safeRoomName(url.searchParams.get("code")).toUpperCase();
      const room = this.rooms[code];
      return room
        ? json({ ok: true, room })
        : json({ ok: false, error: "Sala não encontrada." }, 404);
    }

    if (url.pathname === "/internal/update" && request.method === "POST") {
      const body = await readJson(request);
      if (!body || typeof body.code !== "string") {
        return json({ error: "Dados inválidos." }, 400);
      }
      const code = body.code.toUpperCase();
      const room = this.rooms[code];
      if (!room) {
        return json({ error: "Sala não encontrada." }, 404);
      }
      const players = Number(body.players);
      room.players = Number.isFinite(players)
        ? Math.max(0, Math.min(MAX_PLAYERS, Math.floor(players)))
        : room.players;
      room.updatedAt = Date.now();

      if (room.players === 0) {
        delete this.rooms[code];
      } else {
        room.status = room.players >= MAX_PLAYERS ? "full" : "waiting";
        this.rooms[code] = room;
      }

      await this.ctx.storage.put("rooms", this.rooms);
      return json({ ok: true });
    }

    if (url.pathname === "/rooms/create" && request.method === "POST") {
      const body = await readJson(request);
      const region = normalizeRegion(body?.region);
      const name = safeRoomName(body?.name) || "Partida ONY";
      const code = await this.createRoom({ region, name });
      return json({
        ok: true,
        code,
        room: this.rooms[code],
        maxPlayers: MAX_PLAYERS
      }, 201);
    }

    if (url.pathname === "/rooms/list" && request.method === "GET") {
      const requestedRegion = url.searchParams.get("region");
      const region = requestedRegion ? normalizeRegion(requestedRegion) : null;
      const rooms = Object.values(this.rooms)
        .filter((room) => room.players < MAX_PLAYERS && (!region || room.region === region))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return json({ ok: true, rooms, maxPlayers: MAX_PLAYERS });
    }

    if (url.pathname === "/rooms/join" && request.method === "POST") {
      const body = await readJson(request);
      const code = safeRoomName(body?.code).toUpperCase();
      const room = this.rooms[code];
      if (!room) {
        return json({ ok: false, error: "Código de sala inválido." }, 404);
      }
      if (room.players >= MAX_PLAYERS) {
        return json({ ok: false, error: "Esta sala está cheia." }, 409);
      }
      return json({
        ok: true,
        code,
        region: room.region,
        roomName: room.name,
        players: room.players,
        maxPlayers: MAX_PLAYERS
      });
    }

    if (url.pathname === "/matchmaking/find" && request.method === "POST") {
      const body = await readJson(request);
      const region = normalizeRegion(body?.region);
      const available = Object.values(this.rooms)
        .filter((room) => room.region === region && room.players < MAX_PLAYERS)
        .sort((a, b) => a.players - b.players || b.updatedAt - a.updatedAt)[0];

      if (available) {
        return json({
          ok: true,
          code: available.code,
          region: available.region,
          players: available.players,
          maxPlayers: MAX_PLAYERS,
          created: false
        });
      }

      const code = await this.createRoom({ region, name: "Partida rápida" });
      return json({
        ok: true,
        code,
        region,
        players: 0,
        maxPlayers: MAX_PLAYERS,
        created: true
      }, 201);
    }

    return json({ error: "Rota do LobbyManager não encontrada." }, 404);
  }

  async createRoom({ region, name }) {
    let code;
    do {
      code = makeRoomCode();
    } while (this.rooms[code]);

    this.rooms[code] = {
      code,
      name,
      region,
      players: 0,
      maxPlayers: MAX_PLAYERS,
      status: "waiting",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await this.ctx.storage.put("rooms", this.rooms);
    return code;
  }
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.moveSequence = 0;
    this.playerStates = new Map();
    this.tttPlayers = new Map();
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.winner = null;
    this.draw = false;

    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("gameState");
      if (saved) {
        this.board = Array.isArray(saved.board) && saved.board.length === 9 ? saved.board : this.board;
        this.turn = saved.turn || "X";
        this.winner = saved.winner || null;
        this.draw = Boolean(saved.draw);
        this.moveSequence = Number(saved.moveSequence) || 0;
        this.tttPlayers = new Map(Array.isArray(saved.tttPlayers) ? saved.tttPlayers : []);
      }

      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        if (attachment?.playerId) {
          this.playerStates.set(attachment.playerId, attachment.state || this.defaultPlayerState());
        }
      }
    });
  }

  defaultPlayerState() {
    return { x: 0, y: 0, z: 0, rotation: 0, micActive: false };
  }

  async fetch(request) {
    await this.ready;
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({
        ok: true,
        service: "ONY GameRoom",
        players: this.ctx.getWebSockets().length,
        maxPlayers: MAX_PLAYERS
      });
    }

    const activeSockets = this.ctx.getWebSockets();
    if (activeSockets.length >= MAX_PLAYERS) {
      return new Response("Sala cheia. Limite de 5 jogadores.", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const playerId = crypto.randomUUID();
    const state = this.defaultPlayerState();

    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, state });
    this.playerStates.set(playerId, state);

    this.send(server, {
      type: "welcome",
      id: playerId,
      serverTime: Date.now(),
      maxPlayers: MAX_PLAYERS,
      players: activeSockets.length + 1
    });

    for (const socket of activeSockets) {
      const attachment = socket.deserializeAttachment();
      if (!attachment?.playerId) continue;
      const existingState = attachment.state || this.defaultPlayerState();
      this.send(server, {
        type: "existingPlayer",
        id: attachment.playerId,
        ...existingState
      });
    }

    this.broadcast({
      type: "playerJoined",
      id: playerId,
      ...state,
      players: activeSockets.length + 1,
      maxPlayers: MAX_PLAYERS
    }, server);

    await this.updateLobbyCount(activeSockets.length + 1);
    return new Response(null, { status: 101, webSocket: client });
  }

  async getRoomSnapshot() {
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
    if (this.board.every((cell) => cell !== null)) {
      this.draw = true;
    }
  }

  async persistGameState() {
    await this.ctx.storage.put("gameState", {
      board: this.board,
      turn: this.turn,
      winner: this.winner,
      draw: this.draw,
      moveSequence: this.moveSequence,
      tttPlayers: Array.from(this.tttPlayers.entries())
    });
  }

  resetMatchIfNeeded() {
    this.board = Array(9).fill(null);
    this.turn = "X";
    this.winner = null;
    this.draw = false;
  }

  forwardSignalToTarget(senderSocket, senderId, data) {
    const payload = { ...data, from: senderId };
    if (typeof data.to === "string" && data.to.length > 0) {
      const targets = this.ctx.getWebSockets(data.to);
      for (const targetSocket of targets) {
        if (targetSocket !== senderSocket) {
          this.send(targetSocket, payload);
        }
      }
    } else {
      this.broadcast(payload, senderSocket);
    }
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!data || typeof data.type !== "string") return;
    const attachment = socket.deserializeAttachment();
    const playerId = attachment?.playerId;
    if (!playerId) return;

    if (data.type === "ping") {
      this.send(socket, { type: "pong", t: data.t, serverTime: Date.now() });
      return;
    }

    if (data.type === "micState") {
      const active = Boolean(data.active);
      const state = this.playerStates.get(playerId) || this.defaultPlayerState();
      state.micActive = active;
      this.playerStates.set(playerId, state);
      socket.serializeAttachment({ playerId, state });
      this.broadcast({ type: "micState", from: playerId, id: playerId, active }, socket);
      return;
    }

    if (
      data.type === "webrtcSignal" ||
      data.type === "rtc-offer" ||
      data.type === "rtc-answer" ||
      data.type === "rtc-ice"
    ) {
      this.forwardSignalToTarget(socket, playerId, data);
      return;
    }

    if (data.type === "quickMessage") {
      const rawText = typeof data.message === "string"
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
      if (![x, y, z, rotation].every(Number.isFinite)) return;
      if ([x, y, z, rotation].some((value) => Math.abs(value) > 1e5)) return;

      const previous = this.playerStates.get(playerId) || this.defaultPlayerState();
      const state = { x, y, z, rotation, micActive: previous.micActive };
      this.playerStates.set(playerId, state);
      socket.serializeAttachment({ playerId, state });

      const clientTime = Number(data.t);
      const timestamp = Number.isFinite(clientTime) && Math.abs(Date.now() - clientTime) < 6e4
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
      const usedMarks = new Set(Array.from(this.tttPlayers.values()).map((player) => player.mark));
      const mark = usedMarks.has("X") ? "O" : "X";
      const existingPlayerIds = Array.from(this.tttPlayers.keys()).filter((id) => id !== playerId);
      this.tttPlayers.set(playerId, { id: playerId, name: cleanName, mark });

      await this.persistGameState();
      this.send(socket, { type: "joined-room", id: playerId, mark, existingPlayerIds });
      this.broadcast({ type: "room-state", state: await this.getRoomSnapshot() });
      return;
    }

    if (data.type === "make-move") {
      const index = Number(data.index);
      const player = this.tttPlayers.get(playerId);
      if (!player || this.winner || this.draw || this.tttPlayers.size < 2) return;
      if (player.mark !== this.turn) return;
      if (!Number.isInteger(index) || index < 0 || index > 8 || this.board[index] !== null) return;

      this.board[index] = player.mark;
      this.evaluateBoard();
      if (!this.winner && !this.draw) {
        this.turn = this.turn === "X" ? "O" : "X";
      }

      await this.persistGameState();
      this.broadcast({ type: "room-state", state: await this.getRoomSnapshot() });
      return;
    }

    if (data.type === "reset-game") {
      if (!this.tttPlayers.has(playerId)) return;
      this.resetMatchIfNeeded();
      await this.persistGameState();
      this.broadcast({ type: "room-state", state: await this.getRoomSnapshot() });
      return;
    }

    if (data.type === "leave-room") {
      await this.removePlayer(socket);
    }
  }

  async webSocketClose(socket) {
    await this.ready;
    await this.removePlayer(socket);
  }

  async webSocketError(socket) {
    await this.ready;
    await this.removePlayer(socket);
  }

  async removePlayer(socket) {
    const attachment = socket.deserializeAttachment();
    const playerId = attachment?.playerId;
    if (!playerId) return;

    this.playerStates.delete(playerId);
    this.tttPlayers.delete(playerId);
    this.resetMatchIfNeeded();
    await this.persistGameState();

    const remaining = Math.max(0, this.ctx.getWebSockets().length - 1);
    this.broadcast({ type: "playerLeft", id: playerId, players: remaining }, socket);
    this.broadcast({ type: "room-state", state: await this.getRoomSnapshot() }, socket);
    await this.updateLobbyCount(remaining);
  }

  async updateLobbyCount(players) {
    try {
      const lobbyId = this.env.LOBBY_MANAGER.idFromName("global-lobby");
      const lobby = this.env.LOBBY_MANAGER.get(lobbyId);
      await lobby.fetch("https://lobby.internal/internal/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: this.ctx.id.name, players })
      });
    } catch {}
  }

  send(socket, data) {
    try {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(data));
      }
    } catch {}
  }

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const lobbyId = env.LOBBY_MANAGER.idFromName("global-lobby");
    const lobby = env.LOBBY_MANAGER.get(lobbyId);

    if (url.pathname === "/ice-config") {
      const turnUser = env.TURN_USERNAME ? String(env.TURN_USERNAME) : DEFAULT_METERED_USERNAME;
      const turnPass = env.TURN_CREDENTIAL ? String(env.TURN_CREDENTIAL) : DEFAULT_METERED_CREDENTIAL;

      const iceServers = [
        { urls: "stun:stun.relay.metered.ca:80" },
        { urls: "stun:stun.cloudflare.com:3478" },
        {
          urls: "turn:global.relay.metered.ca:80",
          username: turnUser,
          credential: turnPass
        },
        {
          urls: "turn:global.relay.metered.ca:80?transport=tcp",
          username: turnUser,
          credential: turnPass
        },
        {
          urls: "turn:global.relay.metered.ca:443",
          username: turnUser,
          credential: turnPass
        },
        {
          urls: "turns:global.relay.metered.ca:443?transport=tcp",
          username: turnUser,
          credential: turnPass
        }
      ];

      if (env.TURN_URLS) {
        const urls = String(env.TURN_URLS)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (urls.length) {
          const customTurn = { urls };
          if (env.TURN_USERNAME) customTurn.username = String(env.TURN_USERNAME);
          if (env.TURN_CREDENTIAL) customTurn.credential = String(env.TURN_CREDENTIAL);
          iceServers.push(customTurn);
        }
      }

      return json({ iceServers }, 200, cors);
    }

    if (
      url.pathname === "/rooms/create" ||
      url.pathname === "/rooms/list" ||
      url.pathname === "/rooms/join" ||
      url.pathname === "/matchmaking/find"
    ) {
      const response = await lobby.fetch(
        new Request(`https://lobby.internal${url.pathname}${url.search}`, request)
      );
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname === "/game") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Use WebSocket.", { status: 400, headers: cors });
      }

      const code = safeRoomName(url.searchParams.get("room")).toUpperCase();
      if (!code) {
        return new Response("Código da sala obrigatório.", { status: 400 });
      }

      const roomResponse = await lobby.fetch(
        `https://lobby.internal/internal/room?code=${encodeURIComponent(code)}`
      );
      if (!roomResponse.ok) {
        return new Response("Sala não encontrada.", { status: 404 });
      }

      const { room } = await roomResponse.json();
      const requestedRegion = url.searchParams.get("region");
      if (requestedRegion && normalizeRegion(requestedRegion) !== room.region) {
        return new Response("A região não corresponde à sala.", { status: 400 });
      }

      const id = env.GAME_ROOM.idFromName(code);
      const locationHint = room.region === "EU" ? "weur" : "sam";
      const gameRoom = env.GAME_ROOM.get(id, { locationHint });
      return gameRoom.fetch(request);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "ONY Multiplayer",
        regions: ["BR", "EU"],
        maxPlayers: MAX_PLAYERS
      }, 200, cors);
    }

    return json({
      ok: true,
      service: "ONY Multiplayer Server",
      endpoints: [
        "POST /rooms/create",
        "GET /rooms/list?region=BR",
        "POST /rooms/join",
        "POST /matchmaking/find",
        "GET /game?room=CODIGO",
        "GET /ice-config",
        "GET /health"
      ]
    }, 200, cors);
  }
};
