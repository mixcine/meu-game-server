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
const DEFAULT_TURN_LIMIT_MB = 480;
const BYTES_PER_MB = 1024 * 1024;

const DEFAULT_PASTEFY_API_KEY =
  "cGtzAjhCUnFoVVaC33USW3AkgrrP2ODpXT44eiopqVwDNMAfgvxzF7qQgtsb";
const DEFAULT_PASTEFY_PASTE_ID = "fKPMN7uS";
const DEFAULT_PASTEFY_PART_NAME = "matered-credenciais";

let memoryAccountsCache = {
  items: null,
  expiresAt: 0
};

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

function parsePastefyAccounts(rawText) {
  let data = typeof rawText === "string" ? JSON.parse(rawText) : rawText;

  if (Array.isArray(data) && data[0]?.contents !== undefined) {
    data = typeof data[0].contents === "string" ? JSON.parse(data[0].contents) : data[0].contents;
  } else if (data && typeof data === "object" && !Array.isArray(data) && typeof data.contents === "string") {
    data = JSON.parse(data.contents);
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Lista de credenciais no Pastefy inválida ou vazia.");
  }

  const valid = data
    .map((item, idx) => ({
      label: String(item?.label || `Conta_${idx + 1}`),
      username: String(item?.username || "").trim(),
      credential: String(item?.credential || "").trim()
    }))
    .filter((acc) => acc.username && acc.credential);

  if (valid.length === 0) {
    throw new Error("Nenhuma credencial válida encontrada no Pastefy.");
  }

  return valid;
}

async function getMeteredAccounts(env) {
  const now = Date.now();
  if (memoryAccountsCache.items && memoryAccountsCache.items.length > 0 && now < memoryAccountsCache.expiresAt) {
    return memoryAccountsCache.items;
  }

  const ttlSec = Math.max(30, Number(env.METERED_CACHE_SECONDS || 300) || 300);
  const pastefyUrl = String(env.METERED_ACCOUNTS_URL || "").trim();

  if (pastefyUrl) {
    try {
      const cache = caches.default;
      const cacheKey = new Request(`https://cache.internal/pastefy-metered?u=${encodeURIComponent(pastefyUrl)}`);
      const cachedResp = await cache.match(cacheKey);

      if (cachedResp) {
        const text = await cachedResp.text();
        const parsed = parsePastefyAccounts(text);
        memoryAccountsCache = { items: parsed, expiresAt: now + ttlSec * 1000 };
        return parsed;
      }

      const resp = await fetch(pastefyUrl, {
        headers: { "Accept": "application/json, text/plain;q=0.9" },
        cf: { cacheTtl: ttlSec, cacheEverything: true }
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ao buscar Pastefy`);
      }

      const text = await resp.text();
      const parsed = parsePastefyAccounts(text);

      await cache.put(
        cacheKey,
        new Response(JSON.stringify(parsed), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttlSec}`
          }
        })
      );

      memoryAccountsCache = { items: parsed, expiresAt: now + ttlSec * 1000 };
      return parsed;
    } catch (_) {
      if (memoryAccountsCache.items && memoryAccountsCache.items.length > 0) {
        return memoryAccountsCache.items;
      }
    }
  }

  return [
    {
      label: "Conta_1",
      username: env.TURN_USERNAME ? String(env.TURN_USERNAME) : DEFAULT_METERED_USERNAME,
      credential: env.TURN_CREDENTIAL ? String(env.TURN_CREDENTIAL) : DEFAULT_METERED_CREDENTIAL
    }
  ];
}

function buildIceServersForAccount(account) {
  const turnUser = account.username;
  const turnPass = account.credential;

  return [
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
}

function getCycleKeyAndDaysRemaining(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const cycleKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const nextMonthStartUtc = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  const daysRemaining = Math.max(1, Math.ceil((nextMonthStartUtc - nowMs) / 86400000));
  return { cycleKey, daysRemaining };
}

async function fetchRealMeteredUsage(env) {
  const appName = String(env.METERED_APP_NAME || "onybye").trim();
  const secretKey = String(env.METERED_SECRET_KEY || "").trim();

  if (!secretKey) return null;

  try {
    const resp = await fetch(
      `https://${encodeURIComponent(appName)}.metered.live/api/v1/turn/current_usage?secretKey=${encodeURIComponent(secretKey)}`,
      { cf: { cacheTtl: 60, cacheEverything: true } }
    );

    if (!resp.ok) return null;

    const data = await resp.json();
    const limitMb = Math.round((Number(data.quotaInGB) || 0.5) * 1000);
    const usedMb = Number(((Number(data.usageInGB) || 0) * 1000).toFixed(2));
    const remainingMb = Math.max(0, Number((limitMb - usedMb).toFixed(2)));

    return {
      usedMb,
      remainingMb,
      limitMb,
      exhausted: remainingMb <= 5
    };
  } catch {
    return null;
  }
}

async function syncQuotaToPastefy(env, snapshot) {
  const apiKey = String(env.PASTEFY_API_KEY || DEFAULT_PASTEFY_API_KEY).trim();
  const pasteId = String(env.PASTEFY_PASTE_ID || DEFAULT_PASTEFY_PASTE_ID).trim();
  const partName = String(env.PASTEFY_PART_NAME || DEFAULT_PASTEFY_PART_NAME).trim();

  if (!apiKey || !pasteId) return;

  const usedMb = Number(snapshot?.usedMb ?? 0);
  const limitMb = Number(snapshot?.limitMb ?? DEFAULT_TURN_LIMIT_MB);
  const remainingMb = Number(
    snapshot?.remainingMb ?? Math.max(0, Number((limitMb - usedMb).toFixed(2)))
  );

  const payload = {
    updatedAt: new Date().toISOString(),
    source: snapshot?.source || "ice-config",
    accountLabel: snapshot?.accountLabel || "Conta_1",
    username: snapshot?.username || "",
    usedMb,
    remainingMb,
    limitMb,
    daysRemaining: Number(snapshot?.daysRemaining ?? 0),
    exhausted: Boolean(snapshot?.exhausted)
  };

  const formatted = JSON.stringify(payload, null, 2);

  try {
    await fetch(`https://pastefy.app/api/v2/paste/${encodeURIComponent(pasteId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        title: "ONY Metered TURN Quota",
        content: formatted,
        parts: [
          {
            name: partName,
            content: formatted
          }
        ]
      })
    });
  } catch (_) {}
}

export class LobbyManager extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const [rooms, turnQuota] = await Promise.all([
        ctx.storage.get("rooms"),
        ctx.storage.get("turnQuota")
      ]);
      this.rooms = rooms && typeof rooms === "object" ? rooms : {};
      this.turnQuota = turnQuota && typeof turnQuota === "object"
        ? turnQuota
        : { cycleKey: "", activeIndex: 0, accounts: {} };
    });
  }

  ensureTurnCycle(accounts, env) {
    const { cycleKey, daysRemaining } = getCycleKeyAndDaysRemaining();
    const limitMb = Math.max(50, Number(env.TURN_QUOTA_LIMIT_MB || DEFAULT_TURN_LIMIT_MB) || DEFAULT_TURN_LIMIT_MB);

    if (this.turnQuota.cycleKey !== cycleKey) {
      const envIdx = Math.max(0, Number(env.ACTIVE_TURN_INDEX || 0) || 0);
      this.turnQuota = {
        cycleKey,
        activeIndex: envIdx % Math.max(1, accounts.length),
        accounts: {}
      };
    }

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (!this.turnQuota.accounts[acc.username]) {
        this.turnQuota.accounts[acc.username] = {
          label: acc.label || `Conta_${i + 1}`,
          bytesUsed: 0,
          exhausted: false,
          failures: 0,
          updatedAt: Date.now()
        };
      } else {
        this.turnQuota.accounts[acc.username].label = acc.label || `Conta_${i + 1}`;
      }
    }

    let safeIdx = Math.max(0, Number(this.turnQuota.activeIndex) || 0) % accounts.length;
    if (this.turnQuota.accounts[accounts[safeIdx].username]?.exhausted) {
      const nextAvailable = accounts.findIndex((a) => !this.turnQuota.accounts[a.username]?.exhausted);
      if (nextAvailable !== -1) {
        safeIdx = nextAvailable;
        this.turnQuota.activeIndex = safeIdx;
      }
    }

    return { safeIdx, limitMb, daysRemaining };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/internal/ice-config" && request.method === "GET") {
      const accounts = await getMeteredAccounts(this.env);
      const { safeIdx, limitMb, daysRemaining } = this.ensureTurnCycle(accounts, this.env);
      const rawIdx = url.searchParams.get("account");
      const forceRefresh = url.searchParams.get("force") === "1";

      let chosenIdx = safeIdx;
      if (rawIdx !== null && rawIdx !== "") {
        chosenIdx = Math.max(0, Number(rawIdx) || 0) % accounts.length;
      } else if (forceRefresh && this.turnQuota.accounts[accounts[safeIdx].username]?.exhausted) {
        const nextIdx = accounts.findIndex((a) => !this.turnQuota.accounts[a.username]?.exhausted);
        if (nextIdx !== -1) {
          chosenIdx = nextIdx;
          this.turnQuota.activeIndex = nextIdx;
        }
      }

      await this.ctx.storage.put("turnQuota", this.turnQuota);
      const selected = accounts[chosenIdx];
      const rec = this.turnQuota.accounts[selected.username] || { bytesUsed: 0, exhausted: false };
      const usedMb = Number(((rec.bytesUsed || 0) / BYTES_PER_MB).toFixed(2));
      const remainingMb = Math.max(0, Number((limitMb - usedMb).toFixed(2)));

      return json({
        ok: true,
        accountIndex: chosenIdx,
        totalAccounts: accounts.length,
        accountLabel: selected.label || `Conta_${chosenIdx + 1}`,
        username: selected.username,
        usedMb,
        remainingMb,
        limitMb,
        daysRemaining,
        exhausted: Boolean(rec.exhausted),
        iceServers: buildIceServersForAccount(selected)
      });
    }

    if (url.pathname === "/internal/ice-config/report-failure" && request.method === "POST") {
      const body = await readJson(request);
      const accounts = await getMeteredAccounts(this.env);
      const { safeIdx, limitMb, daysRemaining } = this.ensureTurnCycle(accounts, this.env);

      const reportedUser = String(body?.username || accounts[safeIdx].username || "").trim();
      const reason = String(body?.reason || "ice_failed").slice(0, 80);
      const force = Boolean(body?.force);

      let failedIdx = accounts.findIndex((a) => a.username === reportedUser);
      if (failedIdx === -1) failedIdx = safeIdx;

      const failedAcc = accounts[failedIdx];
      const failedRec = this.turnQuota.accounts[failedAcc.username] || {
        label: failedAcc.label || `Conta_${failedIdx + 1}`,
        bytesUsed: 0,
        exhausted: false,
        failures: 0
      };

      failedRec.failures = (Number(failedRec.failures) || 0) + 1;
      failedRec.lastReason = reason;
      failedRec.updatedAt = Date.now();

      const shouldMarkExhausted = force || failedRec.failures >= 2 || /quota|limit|401|407|exhaust/i.test(reason);
      if (shouldMarkExhausted) {
        failedRec.exhausted = true;
      }
      this.turnQuota.accounts[failedAcc.username] = failedRec;

      let nextIdx = (failedIdx + 1) % accounts.length;
      for (let offset = 1; offset <= accounts.length; offset++) {
        const candidateIdx = (failedIdx + offset) % accounts.length;
        const candUser = accounts[candidateIdx].username;
        if (!this.turnQuota.accounts[candUser]?.exhausted) {
          nextIdx = candidateIdx;
          break;
        }
      }

      if (accounts.every((a) => this.turnQuota.accounts[a.username]?.exhausted)) {
        for (const a of accounts) {
          if (this.turnQuota.accounts[a.username]) {
            this.turnQuota.accounts[a.username].exhausted = false;
            this.turnQuota.accounts[a.username].failures = 0;
          }
        }
        nextIdx = (failedIdx + 1) % accounts.length;
      }

      this.turnQuota.activeIndex = nextIdx;
      await this.ctx.storage.put("turnQuota", this.turnQuota);

      const nextAcc = accounts[nextIdx];
      const nextRec = this.turnQuota.accounts[nextAcc.username] || { bytesUsed: 0, exhausted: false };
      const usedMb = Number(((nextRec.bytesUsed || 0) / BYTES_PER_MB).toFixed(2));
      const remainingMb = Math.max(0, Number((limitMb - usedMb).toFixed(2)));

      return json({
        ok: true,
        markedExhausted: shouldMarkExhausted,
        accountIndex: nextIdx,
        totalAccounts: accounts.length,
        nextUsername: nextAcc.username,
        nextAccountLabel: nextAcc.label || `Conta_${nextIdx + 1}`,
        accountLabel: nextAcc.label || `Conta_${nextIdx + 1}`,
        usedMb,
        remainingMb,
        limitMb,
        daysRemaining,
        exhausted: Boolean(nextRec.exhausted),
        iceServers: buildIceServersForAccount(nextAcc)
      });
    }

    if (url.pathname === "/internal/ice-config/usage" && request.method === "POST") {
      const body = await readJson(request);
      const accounts = await getMeteredAccounts(this.env);
      const { safeIdx, limitMb, daysRemaining } = this.ensureTurnCycle(accounts, this.env);

      const targetUser = String(body?.username || accounts[safeIdx].username || "").trim();
      const deltaBytes = Math.max(0, Number(body?.bytes) || 0);

      let targetIdx = accounts.findIndex((a) => a.username === targetUser);
      if (targetIdx === -1) targetIdx = safeIdx;

      const targetAcc = accounts[targetIdx];
      const rec = this.turnQuota.accounts[targetAcc.username] || {
        label: targetAcc.label || `Conta_${targetIdx + 1}`,
        bytesUsed: 0,
        exhausted: false,
        failures: 0
      };

      rec.bytesUsed = (Number(rec.bytesUsed) || 0) + deltaBytes;
      rec.updatedAt = Date.now();

      const limitBytes = limitMb * BYTES_PER_MB;
      if (rec.bytesUsed >= limitBytes) {
        rec.exhausted = true;
        const nextAvailable = accounts.findIndex((a) => !this.turnQuota.accounts[a.username]?.exhausted && a.username !== targetAcc.username);
        if (nextAvailable !== -1) {
          this.turnQuota.activeIndex = nextAvailable;
        }
      }

      this.turnQuota.accounts[targetAcc.username] = rec;
      await this.ctx.storage.put("turnQuota", this.turnQuota);

      const usedMb = Number((rec.bytesUsed / BYTES_PER_MB).toFixed(2));
      const remainingMb = Math.max(0, Number((limitMb - usedMb).toFixed(2)));
      return json({
        ok: true,
        username: targetAcc.username,
        accountLabel: rec.label,
        usedMb,
        remainingMb,
        limitMb,
        daysRemaining,
        exhausted: Boolean(rec.exhausted)
      });
    }

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const lobbyId = env.LOBBY_MANAGER.idFromName("global-lobby");
    const lobby = env.LOBBY_MANAGER.get(lobbyId);

    if (url.pathname === "/ice-config" && request.method === "GET") {
      const query = new URLSearchParams();
      if (url.searchParams.has("account")) {
        query.set("account", url.searchParams.get("account"));
      }
      if (url.searchParams.has("force")) {
        query.set("force", url.searchParams.get("force"));
      }
      const qs = query.toString();

      const [response, realUsage] = await Promise.all([
        lobby.fetch(`https://lobby.internal/internal/ice-config${qs ? `?${qs}` : ""}`),
        fetchRealMeteredUsage(env)
      ]);

      const rawBody = await response.text();
      let finalBody = rawBody;

      if (response.ok) {
        try {
          const parsed = JSON.parse(rawBody);
          if (realUsage) {
            parsed.usedMb = realUsage.usedMb;
            parsed.remainingMb = realUsage.remainingMb;
            parsed.limitMb = realUsage.limitMb;
            parsed.exhausted = realUsage.exhausted;
          }
          finalBody = JSON.stringify(parsed);
          ctx.waitUntil(
            syncQuotaToPastefy(env, {
              ...parsed,
              source: realUsage ? "ice-config-real" : "ice-config"
            })
          );
        } catch (_) {}
      }

      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(finalBody, { status: response.status, headers });
    }

    if (url.pathname === "/ice-config/report-failure" && request.method === "POST") {
      const response = await lobby.fetch(
        new Request("https://lobby.internal/internal/ice-config/report-failure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: request.body
        })
      );
      const rawBody = await response.text();
      if (response.ok) {
        try {
          const parsed = JSON.parse(rawBody);
          ctx.waitUntil(syncQuotaToPastefy(env, { ...parsed, source: "report-failure" }));
        } catch (_) {}
      }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(rawBody, { status: response.status, headers });
    }

    if (url.pathname === "/ice-config/usage" && request.method === "POST") {
      const response = await lobby.fetch(
        new Request("https://lobby.internal/internal/ice-config/usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: request.body
        })
      );
      const rawBody = await response.text();
      if (response.ok) {
        try {
          const parsed = JSON.parse(rawBody);
          ctx.waitUntil(syncQuotaToPastefy(env, { ...parsed, source: "usage" }));
        } catch (_) {}
      }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(rawBody, { status: response.status, headers });
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
        "POST /ice-config/report-failure",
        "POST /ice-config/usage",
        "GET /health"
      ]
    }, 200, cors);
  }
};
