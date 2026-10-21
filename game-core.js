// Pure server-side simulation helpers. No browser or WebSocket dependencies.
'use strict';

const WORLD = {
  half: 35,
  playerRadius: 0.48,
  playerHeight: 1.8,
  moveSpeed: 9.0,
  airControl: 0.82,
  jumpSpeed: 8.2,
  gravity: 22.0,
  maxHealth: 100,
  shotCooldownMs: 220,
  shotRange: 75,
  shotDamage: 34,
  maxPlayers: 8,
  firstTo: 5,
  roundIntermissionMs: 3200,
  respawnDelayMs: 2200,
  tickRate: 30,
  snapshotRate: 20
};

// [minX, maxX, minZ, maxZ, minY, maxY] collision volumes. Arena coordinates use X/Z.
const SOLIDS = [
  // Central core.
  [-2.7, 2.7, -2.7, 2.7, 0, 2.8],
  // Staggered mid-lane crates.
  [-10.5, -7.0, -5.5, -2.2, 0, 1.8],
  [7.0, 10.5, 2.2, 5.5, 0, 1.8],
  [-10.5, -7.0, 2.2, 5.5, 0, 1.8],
  [7.0, 10.5, -5.5, -2.2, 0, 1.8],
  // Spawn side cover.
  [-30, -26.5, 20, 24, 0, 2.2],
  [26.5, 30, 20, 24, 0, 2.2],
  [-30, -26.5, -24, -20, 0, 2.2],
  [26.5, 30, -24, -20, 0, 2.2],
  // Outer flank crates.
  [-27, -24, -10, -6, 0, 2.4],
  [-27, -24, 6, 10, 0, 2.4],
  [24, 27, -10, -6, 0, 2.4],
  [24, 27, 6, 10, 0, 2.4]
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function normalizeInput(input) {
  const x = clamp(isFiniteNumber(input?.x) ? input.x : 0, -1, 1);
  const z = clamp(isFiniteNumber(input?.z) ? input.z : 0, -1, 1);
  const length = Math.hypot(x, z);
  return length > 1 ? { x: x / length, z: z / length } : { x, z };
}

function groundHeight(x, z) {
  const ax = Math.abs(x);
  // Raised flank platforms with gradual ramps from the ground route.
  if (ax >= 20 && ax <= 27 && Math.abs(z) <= 15) return 3;
  if (ax > 14 && ax < 20 && Math.abs(z) <= 15) return 3 * ((ax - 14) / 6);
  return 0;
}

function overlapsSolid(x, z, feetY, radius = WORLD.playerRadius) {
  for (const [minX, maxX, minZ, maxZ, minY, maxY] of SOLIDS) {
    if (feetY >= maxY || feetY + WORLD.playerHeight <= minY) continue;
    const closestX = clamp(x, minX, maxX);
    const closestZ = clamp(z, minZ, maxZ);
    const dx = x - closestX;
    const dz = z - closestZ;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

function movePlayer(player, dt, allPlayers) {
  dt = clamp(isFiniteNumber(dt) ? dt : 0, 0, 0.05);
  if (!player.alive) return;
  const input = normalizeInput(player.input);
  const yaw = player.yaw;
  // Forward is toward -Z at yaw=0. Right vector is +X at yaw=0.
  const forwardX = Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  const speedScale = player.onGround ? 1 : WORLD.airControl;
  const vx = (rightX * input.x + forwardX * input.z) * WORLD.moveSpeed * speedScale;
  const vz = (rightZ * input.x + forwardZ * input.z) * WORLD.moveSpeed * speedScale;

  const oldX = player.x;
  const oldZ = player.z;
  const nextX = clamp(oldX + vx * dt, -WORLD.half + 1.2, WORLD.half - 1.2);
  const nextZ = clamp(oldZ + vz * dt, -WORLD.half + 1.2, WORLD.half - 1.2);

  // Resolve X and Z independently to support sliding along obstacles.
  if (!overlapsSolid(nextX, oldZ, player.y)) player.x = nextX;
  if (!overlapsSolid(player.x, nextZ, player.y)) player.z = nextZ;

  const floor = groundHeight(player.x, player.z);
  if (player.y <= floor + 0.04 && player.vy <= 0) {
    player.y = floor;
    player.vy = 0;
    player.onGround = true;
  } else {
    player.vy -= WORLD.gravity * dt;
    player.y += player.vy * dt;
    const newFloor = groundHeight(player.x, player.z);
    if (player.y <= newFloor) {
      player.y = newFloor;
      player.vy = 0;
      player.onGround = true;
    } else {
      player.onGround = false;
    }
  }

  // Player-player overlap is not a hard body block in this prototype; it avoids jitter
  // while still preventing the camera/player from crossing arena boundaries.
  player.x = clamp(player.x, -WORLD.half + 1.2, WORLD.half - 1.2);
  player.z = clamp(player.z, -WORLD.half + 1.2, WORLD.half - 1.2);
}

function rayAabbDistance(origin, direction, box, maxDistance) {
  let tmin = 0;
  let tmax = maxDistance;
  const mins = [box[0], box[4], box[2]];
  const maxs = [box[1], box[5], box[3]];
  const origins = [origin.x, origin.y, origin.z];
  const dirs = [direction.x, direction.y, direction.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dirs[i]) < 1e-8) {
      if (origins[i] < mins[i] || origins[i] > maxs[i]) return null;
      continue;
    }
    let t1 = (mins[i] - origins[i]) / dirs[i];
    let t2 = (maxs[i] - origins[i]) / dirs[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin <= maxDistance ? tmin : null;
}

function getAimDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp
  };
}

function validateShot(shooter, targets, now, solids = SOLIDS) {
  if (!shooter || !shooter.alive) return { ok: false, reason: 'not_alive' };
  if (shooter.phase !== 'active') return { ok: false, reason: 'round_not_active' };
  if (now - shooter.lastShotAt < WORLD.shotCooldownMs) return { ok: false, reason: 'cooldown' };
  if (!isFiniteNumber(shooter.yaw) || !isFiniteNumber(shooter.pitch)) return { ok: false, reason: 'invalid_aim' };

  shooter.lastShotAt = now;
  const origin = { x: shooter.x, y: shooter.y + 1.48, z: shooter.z };
  const direction = getAimDirection(shooter.yaw, clamp(shooter.pitch, -1.25, 1.25));
  let nearest = WORLD.shotRange;
  let target = null;

  // Geometry blocks shots before targets.
  for (const box of solids) {
    const distance = rayAabbDistance(origin, direction, box, nearest);
    if (distance !== null && distance < nearest) nearest = distance;
  }

  for (const candidate of targets) {
    if (candidate.id === shooter.id || !candidate.alive || candidate.team === shooter.team) continue;
    const center = { x: candidate.x, y: candidate.y + 0.95, z: candidate.z };
    const to = { x: center.x - origin.x, y: center.y - origin.y, z: center.z - origin.z };
    const along = to.x * direction.x + to.y * direction.y + to.z * direction.z;
    if (along < 0 || along > nearest) continue;
    const px = origin.x + direction.x * along;
    const py = origin.y + direction.y * along;
    const pz = origin.z + direction.z * along;
    const distSq = (center.x - px) ** 2 + (center.y - py) ** 2 + (center.z - pz) ** 2;
    if (distSq <= 0.78 ** 2) {
      nearest = along;
      target = candidate;
    }
  }

  return { ok: true, target, damage: target ? WORLD.shotDamage : 0, direction };
}

function createPlayer(id, name, team, now) {
  return {
    id, name, team, x: team === 1 ? -4 : 4, y: 0, z: team === 1 ? 27 : -27,
    yaw: team === 1 ? 0 : Math.PI, pitch: 0, vy: 0, onGround: true,
    input: { x: 0, z: 0 }, health: WORLD.maxHealth, kills: 0, deaths: 0,
    alive: true, respawnAt: 0, lastShotAt: -Infinity, lastInputAt: now,
    joinedAt: now, spawnProtectedUntil: now + 1200
  };
}

module.exports = {
  WORLD, SOLIDS, clamp, normalizeInput, groundHeight, overlapsSolid,
  movePlayer, getAimDirection, validateShot, createPlayer, rayAabbDistance
};
