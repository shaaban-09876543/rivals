'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  WORLD, SOLIDS, clamp, normalizeInput, movePlayer, validateShot, createPlayer
} = require('./game-core');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PAYLOAD = 4096;
const HEARTBEAT_MS = 10000;
const STALE_MS = 35000;
const RECONNECT_GRACE_MS = 12000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
const players = new Map();          // playerId -> authoritative state
const sockets = new Map();          // playerId -> current socket
const tokenToPlayer = new Map();    // reconnect token -> playerId
const lastPongAt = new Map();
const lastPingAt = new Map();
let phase = 'waiting';
let phaseEndsAt = 0;
let roundId = 0;
let matchId = 1;
let roundScores = { 1: 0, 2: 0 };
let roundWinner = null;
let roundEndGuard = false;
let lastTick = Date.now();
let lastSnapshotAt = 0;

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

function cleanName(name) {
  if (typeof name !== 'string') return 'Player';
  const value = name.replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 16);
  return value || 'Player';
}

function teamCounts() {
  const counts = { 1: 0, 2: 0 };
  for (const player of players.values()) counts[player.team]++;
  return counts;
}

function assignTeam() {
  const counts = teamCounts();
  if (counts[1] < counts[2]) return 1;
  if (counts[2] < counts[1]) return 2;
  return players.size % 2 === 0 ? 1 : 2;
}

function publicPlayer(player) {
  return {
    id: player.id, name: player.name, team: player.team,
    x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch,
    health: player.health, kills: player.kills, deaths: player.deaths,
    alive: player.alive, spawnProtected: Date.now() < player.spawnProtectedUntil
  };
}

function gameState() {
  return {
    type: 'state',
    now: Date.now(),
    phase, phaseEndsAt, roundId, matchId, roundScores: { ...roundScores },
    firstTo: WORLD.firstTo, roundWinner,
    playerIdByToken: undefined,
    players: [...players.values()].map(publicPlayer),
    playerCount: players.size,
    maxPlayers: WORLD.maxPlayers
  };
}

function broadcastState() {
  const state = gameState();
  for (const ws of sockets.values()) safeSend(ws, state);
}

function resetPlayerForRound(player, now) {
  const teamPlayers = [...players.values()].filter(p => p.team === player.team).sort((a, b) => a.joinedAt - b.joinedAt);
  const index = Math.max(0, teamPlayers.findIndex(p => p.id === player.id));
  const offset = (index % 2 === 0 ? -2 : 2);
  player.x = offset;
  player.y = 0;
  player.z = player.team === 1 ? 27 : -27;
  player.yaw = player.team === 1 ? 0 : Math.PI;
  player.pitch = 0;
  player.vy = 0;
  player.onGround = true;
  player.input = { x: 0, z: 0 };
  player.health = WORLD.maxHealth;
  player.alive = true;
  player.respawnAt = 0;
  player.lastShotAt = -Infinity;
  player.spawnProtectedUntil = now + 1200;
}

function startRound(now) {
  if (phase === 'active' || phase === 'starting' || phase === 'ended') return;
  if (players.size < 2 || teamCounts()[1] === 0 || teamCounts()[2] === 0) {
    phase = 'waiting';
    phaseEndsAt = 0;
    return;
  }
  roundId++;
  roundWinner = null;
  roundEndGuard = false;
  for (const player of players.values()) resetPlayerForRound(player, now);
  phase = 'starting';
  phaseEndsAt = now + 1800;
  broadcastState();
}

function endRound(winnerTeam, now, reason = 'elimination') {
  if (phase !== 'active' || roundEndGuard) return false;
  roundEndGuard = true;
  roundWinner = winnerTeam;
  if (winnerTeam === 1 || winnerTeam === 2) roundScores[winnerTeam]++;
  const matchWon = roundScores[1] >= WORLD.firstTo || roundScores[2] >= WORLD.firstTo;
  phase = matchWon ? 'ended' : 'intermission';
  phaseEndsAt = matchWon ? 0 : now + WORLD.roundIntermissionMs;
  broadcastEvent({ type: 'roundEnd', roundId, winnerTeam, scores: { ...roundScores }, reason, matchWon });
  broadcastState();
  return true;
}

function broadcastEvent(event) {
  for (const ws of sockets.values()) safeSend(ws, event);
}

function maybeResolveRound(now) {
  if (phase !== 'active' || roundEndGuard) return;
  const aliveTeams = new Set([...players.values()].filter(p => p.alive).map(p => p.team));
  if (aliveTeams.size === 1) endRound([...aliveTeams][0], now);
  else if (aliveTeams.size === 0) endRound(null, now, 'draw');
}

function removePlayer(playerId, reason = 'disconnect') {
  const player = players.get(playerId);
  if (!player) return;
  players.delete(playerId);
  sockets.delete(playerId);
  lastPongAt.delete(playerId);
  lastPingAt.delete(playerId);
  for (const [token, id] of tokenToPlayer.entries()) if (id === playerId) tokenToPlayer.delete(token);

  // A roster change invalidates the current round. Never award a round for a disconnect.
  if (phase === 'active' || phase === 'starting' || phase === 'intermission' || phase === 'ended') {
    matchId++;
    roundScores = { 1: 0, 2: 0 };
    roundWinner = null;
    roundEndGuard = false;
    phase = 'waiting';
    phaseEndsAt = 0;
    for (const p of players.values()) resetPlayerForRound(p, Date.now());
  }
  broadcastEvent({ type: 'playerLeft', playerId, reason });
  broadcastState();
  if (players.size >= 2) startRound(Date.now());
}

function attachPlayer(ws, player, token) {
  const oldSocket = sockets.get(player.id);
  if (oldSocket && oldSocket !== ws) {
    safeSend(oldSocket, { type: 'replaced', message: 'This session reconnected in another connection.' });
    try { oldSocket.close(4001, 'Session replaced'); } catch (_) {}
  }
  sockets.set(player.id, ws);
  tokenToPlayer.set(token, player.id);
  ws.playerId = player.id;
  ws.token = token;
  lastPongAt.set(player.id, Date.now());
  lastPingAt.set(player.id, Date.now());
  player.lastInputAt = Date.now();
  ws.isAlive = true;
  safeSend(ws, {
    type: 'welcome', playerId: player.id, token, phase, roundId, matchId,
    state: gameState()
  });
  broadcastState();
  if (players.size >= 2 && phase === 'waiting') startRound(Date.now());
}

function sendError(ws, code, message) {
  safeSend(ws, { type: 'error', code, message });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.lastMessageAt = Date.now();

  ws.on('pong', () => {
    ws.isAlive = true;
    if (ws.playerId) lastPongAt.set(ws.playerId, Date.now());
  });

  ws.on('message', (raw) => {
    ws.lastMessageAt = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      sendError(ws, 'bad_json', 'Invalid message.');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      sendError(ws, 'bad_message', 'Invalid message shape.');
      return;
    }

    if (msg.type === 'hello') {
      if (ws.playerId) return;
      const token = typeof msg.token === 'string' && /^[a-f0-9-]{20,80}$/i.test(msg.token) ? msg.token : null;
      let player = token ? players.get(tokenToPlayer.get(token)) : null;
      if (player) {
        attachPlayer(ws, player, token);
        return;
      }
      if (players.size >= WORLD.maxPlayers) {
        sendError(ws, 'server_full', 'Arena is full. Try again shortly.');
        ws.close(4002, 'Server full');
        return;
      }
      if (phase === 'ended') {
        matchId++;
        roundScores = { 1: 0, 2: 0 };
        roundWinner = null;
        roundEndGuard = false;
        phase = 'waiting';
        phaseEndsAt = 0;
      }
      const id = crypto.randomUUID();
      const newToken = crypto.randomUUID();
      const team = assignTeam();
      player = createPlayer(id, cleanName(msg.name), team, Date.now());
      players.set(id, player);
      attachPlayer(ws, player, newToken);
      return;
    }

    if (!ws.playerId) {
      sendError(ws, 'not_ready', 'Connect before sending gameplay input.');
      return;
    }
    const player = players.get(ws.playerId);
    if (!player || sockets.get(player.id) !== ws) return;

    if (msg.type === 'input') {
      const now = Date.now();
      if (now - player.lastInputAt < 8) return; // cap input messages near 125/s
      player.lastInputAt = now;
      const x = Number(msg.x), z = Number(msg.z);
      const yaw = Number(msg.yaw), pitch = Number(msg.pitch);
      if (![x, z, yaw, pitch].every(Number.isFinite) || Math.abs(yaw) > 1000 || Math.abs(pitch) > 1000) {
        sendError(ws, 'invalid_input', 'Invalid movement or aim values.');
        return;
      }
      player.input = normalizeInput({ x, z });
      // Angles are constrained and normalised server-side.
      player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      player.pitch = clamp(pitch, -1.25, 1.25);
      return;
    }

    if (msg.type === 'jump') {
      if (phase === 'active' && player.alive && player.onGround) {
        player.vy = WORLD.jumpSpeed;
        player.onGround = false;
      }
      return;
    }

    if (msg.type === 'fire') {
      const now = Date.now();
      if (phase !== 'active' || !player.alive) return;
      const targets = [...players.values()];
      const shot = validateShot({ ...player, phase }, targets, now, SOLIDS);
      // validateShot changes the clone's cooldown; enforce it on authoritative state.
      if (!shot.ok) return;
      player.lastShotAt = now;
      const target = shot.target;
      broadcastEvent({
        type: 'shot', shooterId: player.id,
        hit: Boolean(target), targetId: target?.id || null,
        x: player.x, y: player.y + 1.48, z: player.z,
        direction: shot.direction, timestamp: now
      });
      if (target && now >= target.spawnProtectedUntil) {
        target.health = Math.max(0, target.health - shot.damage);
        broadcastEvent({ type: 'hit', shooterId: player.id, targetId: target.id, damage: shot.damage, health: target.health });
        if (target.health <= 0 && target.alive) {
          target.alive = false;
          target.deaths++;
          player.kills++;
          target.input = { x: 0, z: 0 };
          broadcastEvent({ type: 'death', playerId: target.id, killerId: player.id });
          maybeResolveRound(now);
        }
      }
      return;
    }

    if (msg.type === 'ping') {
      safeSend(ws, { type: 'pong', at: msg.at, serverTime: Date.now() });
      return;
    }
    sendError(ws, 'unknown_type', 'Unsupported message type.');
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (!id || sockets.get(id) !== ws) return; // old replaced socket must not evict new session
    sockets.delete(id);
    const timer = setTimeout(() => {
      if (!sockets.has(id) && players.has(id)) removePlayer(id, 'connection_lost');
    }, RECONNECT_GRACE_MS);
    timer.unref?.();
  });

  ws.on('error', () => {});
});

const tickMs = 1000 / WORLD.tickRate;
const timer = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  if (phase === 'starting' && now >= phaseEndsAt) {
    phase = 'active';
    phaseEndsAt = 0;
    broadcastEvent({ type: 'roundStart', roundId });
    broadcastState();
  } else if (phase === 'intermission' && now >= phaseEndsAt) {
    startRound(now);
  }

  if (phase === 'active') {
    for (const player of players.values()) movePlayer(player, dt, players);
    maybeResolveRound(now);
  }

  // Ping every connected socket and terminate peers that have stopped responding.
  for (const [id, ws] of sockets.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const lastPong = lastPongAt.get(id) || now;
    if (now - lastPong > STALE_MS) {
      try { ws.terminate(); } catch (_) {}
      continue;
    }
    if (now - (lastPingAt.get(id) || 0) >= HEARTBEAT_MS) {
      try {
        ws.ping();
        lastPingAt.set(id, now);
      } catch (_) {}
    }
  }

  if (now - lastSnapshotAt >= 1000 / WORLD.snapshotRate) {
    lastSnapshotAt = now;
    broadcastState();
  }
}, tickMs);
timer.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`[Foundry Yard] HTTP/WebSocket server listening on http://${HOST}:${PORT}`);
  console.log(`[Foundry Yard] Authoritative tick ${WORLD.tickRate} Hz; snapshots ${WORLD.snapshotRate} Hz`);
});

function shutdown() {
  clearInterval(timer);
  for (const ws of sockets.values()) {
    try { ws.close(1001, 'Server shutting down'); } catch (_) {}
  }
  wss.close(() => server.close(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
