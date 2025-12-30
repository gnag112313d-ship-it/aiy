const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;

// -------------------- App / Socket --------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

// 정적 파일
app.use(express.static(path.join(__dirname, "public")));

// -------------------- Persistent DB Path --------------------
// 전세계 저장(재시작해도 유지) = "서버 컴퓨터에 파일이 남아야" 함.
// Render 같은 곳은 Persistent Disk 없으면 재시작 때 날아갈 수 있음.
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR; // 사용자 지정
  // Render에서 많이 쓰는 관례 경로
  const renderDisk = "/var/data";
  try {
    if (fs.existsSync(renderDisk)) return renderDisk;
  } catch {}
  // 로컬 개발
  return path.join(__dirname, "data");
}
const DATA_DIR = pickDataDir();
const DB_PATH = path.join(DATA_DIR, "db.json");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function safeWriteJSON(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { players: {}, leaderboard: [] };
    safeWriteJSON(DB_PATH, init);
    return init;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { players: {}, leaderboard: [] };
  }
}

let DB = loadDB();
let dirty = false;

function saveDBSoon() {
  dirty = true;
}

// 1.2초마다 더티면 저장 (atomic)
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    safeWriteJSON(DB_PATH, DB);
  } catch {}
}, 1200);

// -------------------- Game Rules --------------------
const RULES = {
  // “5번 맞추기” = HP 5
  hpMax: 5,

  // “7판제 + 4선승”
  maxRounds: 7,
  targetWins: 4,

  // 공속/바위 속도 살짝 느리게
  shootCooldown: 0.72, // 이전 0.55보다 느림
  rockSpeed: 620,      // 이전 680보다 느림

  // 매칭/보상 악용 방지
  offlineRewardCooldownMs: 30_000, // 오프라인(AI/로컬) 보상: 30초에 1번만
  inputRateLimitMs: 20,           // 입력 너무 과하면 무시
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function nowMs() {
  return Date.now();
}
function xpToLevel(xp) {
  const v = Math.max(0, Number(xp) || 0);
  return 1 + Math.floor(Math.sqrt(v / 120));
}
function tierFromRating(rating) {
  const r = Number(rating) || 0;
  if (r < 900) return "아이언";
  if (r < 1050) return "브론즈";
  if (r < 1200) return "실버";
  if (r < 1350) return "골드";
  if (r < 1500) return "플래티넘";
  if (r < 1650) return "다이아";
  if (r < 1850) return "마스터";
  if (r < 2100) return "그랜드마스터";
  return "챌린저";
}

// -------------------- Player / Profile --------------------
function ensurePlayer(profile) {
  const id = String(profile?.id || "");
  const name = String(profile?.name || "Player").slice(0, 16) || "Player";
  if (!id) return null;

  if (!DB.players[id]) {
    DB.players[id] = {
      id,
      name,
      xp: 0,
      rubies: 0,
      rockSkin: "default",
      ownedSkins: ["default"],
      rating: 1000,
      wins: 0,
      losses: 0,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      lastOfflineRewardAt: 0,
    };
    saveDBSoon();
  } else {
    DB.players[id].name = name;
    DB.players[id].updatedAt = nowMs();
    saveDBSoon();
  }

  const p = DB.players[id];
  p.level = xpToLevel(p.xp);
  p.tier = tierFromRating(p.rating);
  return p;
}

function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    xp: p.xp,
    level: xpToLevel(p.xp),
    rubies: p.rubies,
    rockSkin: p.rockSkin,
    ownedSkins: p.ownedSkins,
    rating: p.rating,
    tier: tierFromRating(p.rating),
    wins: p.wins,
    losses: p.losses,
  };
}

function rebuildLeaderboard() {
  const arr = Object.values(DB.players).map((p) => ({
    id: p.id,
    name: p.name,
    rating: p.rating,
    tier: tierFromRating(p.rating),
    wins: p.wins,
    losses: p.losses,
    level: xpToLevel(p.xp),
  }));
  arr.sort((a, b) => b.rating - a.rating);
  DB.leaderboard = arr.slice(0, 100);
}

// -------------------- Rewards / Elo --------------------
function awardAfterMatch(playerId, result, ranked) {
  const p = DB.players[playerId];
  if (!p) return;

  const baseXp = ranked ? 45 : 25;
  const baseRubies = ranked ? 9 : 5;
  const winBonusXp = ranked ? 35 : 18;
  const winBonusRubies = ranked ? 6 : 3;

  const xpGain = baseXp + (result === "win" ? winBonusXp : 0);
  const rubyGain = baseRubies + (result === "win" ? winBonusRubies : 0);

  p.xp += xpGain;
  p.rubies += rubyGain;

  if (result === "win") p.wins += 1;
  else p.losses += 1;

  p.level = xpToLevel(p.xp);
  p.tier = tierFromRating(p.rating);
  p.updatedAt = nowMs();
  saveDBSoon();
}

function updateRating(pA, pB, winnerId) {
  const K = 28;
  const Ra = pA.rating;
  const Rb = pB.rating;

  const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
  const Eb = 1 / (1 + Math.pow(10, (Ra - Rb) / 400));

  const Sa = winnerId === pA.id ? 1 : 0;
  const Sb = 1 - Sa;

  pA.rating = Math.round(clamp(Ra + K * (Sa - Ea), 1, 9999));
  pB.rating = Math.round(clamp(Rb + K * (Sb - Eb), 1, 9999));
  pA.tier = tierFromRating(pA.rating);
  pB.tier = tierFromRating(pB.rating);
  saveDBSoon();
}

// -------------------- Shop --------------------
const SHOP = [
  { id: "default",  name: "기본 바위",     price: 0,   color: "#9aa0a6", trail: 0.15 },
  { id: "ruby",     name: "루비 바위",     price: 120, color: "#ff4b4b", trail: 0.22 },
  { id: "emerald",  name: "에메랄드 바위", price: 160, color: "#2ee59d", trail: 0.22 },
  { id: "sapphire", name: "사파이어 바위", price: 200, color: "#4b7bff", trail: 0.24 },
  { id: "gold",     name: "골드 바위",     price: 260, color: "#ffd34b", trail: 0.26 },
];

// -------------------- Matchmaking --------------------
const casualQueue = [];
const rankedQueue = [];

function removeFromQueue(queue, socketId) {
  const idx = queue.findIndex((q) => q.socketId === socketId);
  if (idx >= 0) queue.splice(idx, 1);
}

function enqueue(queue, socket, mode) {
  queue.push({
    socketId: socket.id,
    playerId: socket.data.playerId,
    name: socket.data.name,
    rating: DB.players[socket.data.playerId]?.rating ?? 1000,
    enqueuedAt: nowMs(),
    mode,
  });
}

// 큐 정리(죽은 소켓, 너무 오래된 대기)
setInterval(() => {
  const clean = (q) => {
    for (let i = q.length - 1; i >= 0; i--) {
      const e = q[i];
      const s = io.sockets.sockets.get(e.socketId);
      if (!s) q.splice(i, 1);
      else if (nowMs() - e.enqueuedAt > 5 * 60_000) q.splice(i, 1); // 5분 컷
    }
  };
  clean(casualQueue);
  clean(rankedQueue);
}, 5000);

// 랭크는 레이팅 비슷한 사람끼리 우선 매칭
function tryMatchRanked(queue) {
  if (queue.length < 2) return;

  // 오래 기다린 사람부터
  queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const sa = io.sockets.sockets.get(a.socketId);
    if (!sa) continue;

    // 기다린 시간에 따라 허용 레이팅 차이 증가
    const waited = nowMs() - a.enqueuedAt;
    const maxGap = 120 + Math.floor(waited / 10_000) * 60; // 10초마다 +60

    let bestJ = -1;
    let bestGap = Infinity;

    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      const sb = io.sockets.sockets.get(b.socketId);
      if (!sb) continue;

      const gap = Math.abs((a.rating ?? 1000) - (b.rating ?? 1000));
      if (gap <= maxGap && gap < bestGap) {
        bestGap = gap;
        bestJ = j;
      }
    }

    if (bestJ >= 0) {
      const b = queue[bestJ];
      // 제거(큰 인덱스 먼저)
      queue.splice(bestJ, 1);
      queue.splice(i, 1);
      startMatch(a, b, true);
      return;
    }
  }
}

function tryMatchCasual(queue) {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    startMatch(a, b, false);
  }
}

const MATCHES = new Map();

function createMatchState(room, pLeft, pRight, ranked) {
  const W = 900, H = 450;
  const groundY = 360;
  return {
    room,
    ranked,
    W,
    H,
    groundY,

    round: 1,
    maxRounds: RULES.maxRounds,
    targetWins: RULES.targetWins,
    scoreL: 0,
    scoreR: 0,

    over: false,
    winnerId: null,

    players: {
      left:  { id: pLeft,  x: 120,     y: groundY, vx: 0, vy: 0, onGround: true, hp: RULES.hpMax, cooldown: 0 },
      right: { id: pRight, x: W - 120, y: groundY, vx: 0, vy: 0, onGround: true, hp: RULES.hpMax, cooldown: 0 },
    },
    rocks: [],
    inputs: {
      [pLeft]:  { l: false, r: false, j: false, shoot: false },
      [pRight]: { l: false, r: false, j: false, shoot: false },
    },
  };
}

function startMatch(a, b, ranked) {
  const sa = io.sockets.sockets.get(a.socketId);
  const sb = io.sockets.sockets.get(b.socketId);
  if (!sa || !sb) return;

  const room = `match_${a.socketId}_${b.socketId}_${nowMs()}`;

  sa.join(room);
  sb.join(room);

  sa.data.room = room;
  sb.data.room = room;
  sa.data.inMatch = true;
  sb.data.inMatch = true;

  const match = createMatchState(room, a.playerId, b.playerId, ranked);
  MATCHES.set(room, match);

  io.to(room).emit("match_start", {
    room,
    ranked,
    players: [
      { playerId: a.playerId, name: a.name, side: "left" },
      { playerId: b.playerId, name: b.name, side: "right" },
    ],
  });
}

function rectHit(px, py, rx, ry, rw, rh) {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

function resetForNextRound(m) {
  m.round += 1;

  m.players.left.hp = RULES.hpMax;
  m.players.right.hp = RULES.hpMax;

  m.players.left.x = 120;
  m.players.right.x = m.W - 120;

  m.players.left.vx = m.players.right.vx = 0;
  m.players.left.vy = m.players.right.vy = 0;
  m.players.left.onGround = m.players.right.onGround = true;

  m.players.left.cooldown = 0;
  m.players.right.cooldown = 0;

  m.rocks.length = 0;
}

function finishMatch(m, winnerId, reason = "normal") {
  if (m.over) return;
  m.over = true;
  m.winnerId = winnerId;

  const leftId = m.players.left.id;
  const rightId = m.players.right.id;
  const loserId = winnerId === leftId ? rightId : leftId;

  const pW = DB.players[winnerId];
  const pL = DB.players[loserId];

  if (m.ranked && pW && pL) updateRating(pW, pL, winnerId);

  awardAfterMatch(winnerId, "win", m.ranked);
  awardAfterMatch(loserId, "lose", m.ranked);

  rebuildLeaderboard();

  io.to(m.room).emit("match_over", {
    winnerId,
    ranked: m.ranked,
    reason, // "normal" | "forfeit"
    profiles: {
      [winnerId]: pW ? publicProfile(pW) : null,
      [loserId]: pL ? publicProfile(pL) : null,
    },
    leaderboard: DB.leaderboard,
  });

  MATCHES.delete(m.room);
}

function stepMatch(m, dt) {
  const speed = 320;
  const jumpV = -520;
  const gravity = 1400;
  const rockSpeed = RULES.rockSpeed;
  const hitboxW = 46, hitboxH = 62;

  // movement + shoot
  for (const side of ["left", "right"]) {
    const pl = m.players[side];
    const input = m.inputs[pl.id] || { l: false, r: false, j: false, shoot: false };

    let ax = 0;
    if (input.l) ax -= 1;
    if (input.r) ax += 1;
    pl.vx = ax * speed;

    if (input.j && pl.onGround) {
      pl.vy = jumpV;
      pl.onGround = false;
    }

    pl.cooldown = Math.max(0, pl.cooldown - dt);

    if (input.shoot && pl.cooldown <= 0) {
      pl.cooldown = RULES.shootCooldown;
      const dir = side === "left" ? 1 : -1;

      m.rocks.push({
        x: pl.x + dir * 34,
        y: pl.y - 40,
        vx: dir * rockSpeed,
        vy: -40,
        owner: pl.id,
        alive: true,
        bornAt: nowMs(),
      });

      io.to(m.room).emit("sfx_shoot", { owner: pl.id });
    }
  }

  // integrate players
  for (const side of ["left", "right"]) {
    const pl = m.players[side];
    pl.x += pl.vx * dt;
    pl.y += pl.vy * dt;
    pl.vy += gravity * dt;

    if (side === "left") pl.x = clamp(pl.x, 40, m.W / 2 - 40);
    else pl.x = clamp(pl.x, m.W / 2 + 40, m.W - 40);

    if (pl.y >= m.groundY) {
      pl.y = m.groundY;
      pl.vy = 0;
      pl.onGround = true;
    }
  }

  // rocks
  for (const rock of m.rocks) {
    if (!rock.alive) continue;

    rock.x += rock.vx * dt;
    rock.y += rock.vy * dt;
    rock.vy += gravity * 0.35 * dt;

    if (rock.x < -100 || rock.x > m.W + 100 || rock.y > m.H + 200) {
      rock.alive = false;
      continue;
    }

    for (const side of ["left", "right"]) {
      const pl = m.players[side];
      if (pl.id === rock.owner) continue;

      const rx = pl.x - hitboxW / 2;
      const ry = pl.y - hitboxH;

      if (rectHit(rock.x, rock.y, rx, ry, hitboxW, hitboxH)) {
        rock.alive = false;
        pl.hp -= 1;

        // knockback
        pl.vy = -220;
        pl.x += (rock.vx > 0 ? 1 : -1) * 18;

        io.to(m.room).emit("sfx_hit", { target: pl.id, owner: rock.owner });
      }
    }
  }
  m.rocks = m.rocks.filter((r) => r.alive);

  // round end
  const left = m.players.left;
  const right = m.players.right;

  if (left.hp <= 0 || right.hp <= 0) {
    const leftWonRound = right.hp <= 0;
    if (leftWonRound) m.scoreL += 1;
    else m.scoreR += 1;

    // win?
    if (m.scoreL >= m.targetWins) return finishMatch(m, left.id);
    if (m.scoreR >= m.targetWins) return finishMatch(m, right.id);

    // safety end on maxRounds
    if (m.round >= m.maxRounds) {
      const winner = m.scoreL >= m.scoreR ? left.id : right.id;
      return finishMatch(m, winner);
    }

    resetForNextRound(m);
  }
}

// tick
let lastTick = nowMs();
setInterval(() => {
  const t = nowMs();
  const dt = clamp((t - lastTick) / 1000, 0, 0.05);
  lastTick = t;

  // ranked matchmaking
  tryMatchRanked(rankedQueue);
  // casual matchmaking
  tryMatchCasual(casualQueue);

  // matches
  for (const m of MATCHES.values()) {
    if (!m.over) stepMatch(m, dt);

    io.to(m.room).emit("state", {
      t,
      W: m.W,
      H: m.H,
      groundY: m.groundY,

      round: m.round,
      maxRounds: m.maxRounds,
      targetWins: m.targetWins,
      scoreL: m.scoreL,
      scoreR: m.scoreR,

      players: m.players,
      rocks: m.rocks,
    });
  }
}, 1000 / 30);

// -------------------- Socket handlers --------------------
io.on("connection", (socket) => {
  socket.data.inMatch = false;
  socket.data.room = null;
  socket.data.playerId = null;
  socket.data.name = "Player";
  socket.data.lastInputAt = 0;

  socket.on("hello", (payload, cb) => {
    const p = ensurePlayer(payload?.profile);
    if (!p) return cb?.({ ok: false, error: "invalid_profile" });

    socket.data.playerId = p.id;
    socket.data.name = p.name;

    rebuildLeaderboard();
    cb?.({
      ok: true,
      profile: publicProfile(p),
      shop: SHOP,
      leaderboard: DB.leaderboard,
    });
  });

  // ✅ AI전/로컬 보상 저장 (악용 방지 포함)
  socket.on("offline_result", ({ result }, cb) => {
    const pid = socket.data.playerId;
    if (!pid || !DB.players[pid]) return cb?.({ ok: false });

    const p = DB.players[pid];
    const now = nowMs();
    if (now - (p.lastOfflineRewardAt || 0) < RULES.offlineRewardCooldownMs) {
      return cb?.({
        ok: false,
        error: "cooldown",
        waitMs: RULES.offlineRewardCooldownMs - (now - (p.lastOfflineRewardAt || 0)),
      });
    }

    p.lastOfflineRewardAt = now;
    saveDBSoon();

    awardAfterMatch(pid, result === "win" ? "win" : "lose", false);
    rebuildLeaderboard();

    cb?.({
      ok: true,
      profile: publicProfile(DB.players[pid]),
      leaderboard: DB.leaderboard,
    });
  });

  socket.on("shop_buy", (skinId, cb) => {
    const pid = socket.data.playerId;
    if (!pid || !DB.players[pid]) return cb?.({ ok: false });

    const p = DB.players[pid];
    const item = SHOP.find((s) => s.id === skinId);
    if (!item) return cb?.({ ok: false, error: "no_item" });

    if (p.ownedSkins.includes(skinId)) {
      return cb?.({ ok: true, profile: publicProfile(p) });
    }
    if (p.rubies < item.price) return cb?.({ ok: false, error: "no_rubies" });

    p.rubies -= item.price;
    p.ownedSkins.push(skinId);
    p.updatedAt = nowMs();
    saveDBSoon();

    cb?.({ ok: true, profile: publicProfile(p) });
  });

  socket.on("shop_equip", (skinId, cb) => {
    const pid = socket.data.playerId;
    if (!pid || !DB.players[pid]) return cb?.({ ok: false });

    const p = DB.players[pid];
    if (!p.ownedSkins.includes(skinId)) return cb?.({ ok: false, error: "not_owned" });

    p.rockSkin = skinId;
    p.updatedAt = nowMs();
    saveDBSoon();

    cb?.({ ok: true, profile: publicProfile(p) });
  });

  socket.on("queue_join", ({ ranked }, cb) => {
    const pid = socket.data.playerId;
    if (!pid || !DB.players[pid]) return cb?.({ ok: false });

    const p = DB.players[pid];
    const level = xpToLevel(p.xp);

    if (ranked && level < 15) {
      return cb?.({ ok: false, error: "rank_locked", needLevel: 15 });
    }

    removeFromQueue(casualQueue, socket.id);
    removeFromQueue(rankedQueue, socket.id);

    enqueue(ranked ? rankedQueue : casualQueue, socket, ranked ? "ranked" : "casual");
    cb?.({ ok: true });
  });

  // ✅ 온라인에서 “나가기” 누르면 기권패
  socket.on("queue_leave", () => {
    removeFromQueue(casualQueue, socket.id);
    removeFromQueue(rankedQueue, socket.id);

    const room = socket.data.room;
    if (room && MATCHES.has(room)) {
      const m = MATCHES.get(room);
      if (m && !m.over) {
        const leftId = m.players.left.id;
        const rightId = m.players.right.id;
        const leaverId = socket.data.playerId;
        const winnerId = leaverId === leftId ? rightId : leftId;
        finishMatch(m, winnerId, "forfeit");
      }
    }
  });

  // 입력 과다 방지
  socket.on("input", (input) => {
    const pid = socket.data.playerId;
    const room = socket.data.room;
    if (!pid || !room) return;

    const t = nowMs();
    if (t - (socket.data.lastInputAt || 0) < RULES.inputRateLimitMs) return;
    socket.data.lastInputAt = t;

    const m = MATCHES.get(room);
    if (!m) return;

    m.inputs[pid] = {
      l: !!input?.l,
      r: !!input?.r,
      j: !!input?.j,
      shoot: !!input?.shoot,
    };
  });

  socket.on("disconnect", () => {
    removeFromQueue(casualQueue, socket.id);
    removeFromQueue(rankedQueue, socket.id);

    // 온라인 매치 중 나가면 기권패
    const room = socket.data.room;
    if (room && MATCHES.has(room)) {
      const m = MATCHES.get(room);
      if (m && !m.over) {
        const leftId = m.players.left.id;
        const rightId = m.players.right.id;
        const leaverId = socket.data.playerId;
        const winnerId = leaverId === leftId ? rightId : leftId;
        finishMatch(m, winnerId, "forfeit");
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("DB_PATH:", DB_PATH);
});

