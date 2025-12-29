const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

app.use(express.static(path.join(__dirname, "public")));

// -------------------- DB (local json) --------------------
const DB_PATH = path.join(__dirname, "data", "db.json");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { players: {}, leaderboard: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2), "utf8");
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
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), "utf8");
  } catch {}
}, 1200);

// -------------------- helpers --------------------
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function xpToLevel(xp) {
  // 완만한 성장: Lv ≈ 1 + floor(sqrt(xp / 120))
  return 1 + Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 120));
}

function nowMs() {
  return Date.now();
}

function ensurePlayer(profile) {
  // profile: { id, name }
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
    };
    saveDBSoon();
  } else {
    DB.players[id].name = name;
    DB.players[id].updatedAt = nowMs();
    saveDBSoon();
  }

  const p = DB.players[id];
  p.level = xpToLevel(p.xp);
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
    wins: p.wins,
    losses: p.losses,
  };
}

function rebuildLeaderboard() {
  const arr = Object.values(DB.players).map((p) => ({
    id: p.id,
    name: p.name,
    rating: p.rating,
    wins: p.wins,
    losses: p.losses,
    level: xpToLevel(p.xp),
  }));
  arr.sort((a, b) => b.rating - a.rating);
  DB.leaderboard = arr.slice(0, 100);
}

function awardAfterMatch(playerId, result, ranked) {
  // result: "win" | "lose"
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
  p.updatedAt = nowMs();
  saveDBSoon();
}

function updateRating(pA, pB, winnerId) {
  // 간단 ELO
  const K = 28;
  const Ra = pA.rating,
    Rb = pB.rating;

  const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
  const Eb = 1 / (1 + Math.pow(10, (Ra - Rb) / 400));

  const Sa = winnerId === pA.id ? 1 : 0;
  const Sb = 1 - Sa;

  pA.rating = Math.round(clamp(Ra + K * (Sa - Ea), 1, 9999));
  pB.rating = Math.round(clamp(Rb + K * (Sb - Eb), 1, 9999));
  saveDBSoon();
}

// -------------------- Matchmaking --------------------
const casualQueue = [];
const rankedQueue = [];

function enqueue(queue, socket, mode) {
  queue.push({
    socketId: socket.id,
    playerId: socket.data.playerId,
    name: socket.data.name,
    enqueuedAt: nowMs(),
    mode,
  });
}

function removeFromQueue(queue, socketId) {
  const idx = queue.findIndex((q) => q.socketId === socketId);
  if (idx >= 0) queue.splice(idx, 1);
}

// -------------------- In-match simulation (server-authoritative) --------------------
const MATCHES = new Map();

function createMatchState(room, pLeft, pRight, ranked) {
  const W = 900,
    H = 450;
  const groundY = 360;

  return {
    room,
    ranked,
    W,
    H,
    groundY,
    startAt: nowMs(),
    over: false,
    winnerId: null,

    players: {
      left: {
        id: pLeft,
        x: 120,
        y: groundY,
        vx: 0,
        vy: 0,
        onGround: true,
        hp: 3,
        cooldown: 0,
      },
      right: {
        id: pRight,
        x: W - 120,
        y: groundY,
        vx: 0,
        vy: 0,
        onGround: true,
        hp: 3,
        cooldown: 0,
      },
    },
    rocks: [],
    inputs: {
      [pLeft]: { l: false, r: false, j: false, shoot: false },
      [pRight]: { l: false, r: false, j: false, shoot: false },
    },
  };
}

function tryMatch(queue, ranked) {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();

    const sa = io.sockets.sockets.get(a.socketId);
    const sb = io.sockets.sockets.get(b.socketId);
    if (!sa || !sb) continue;

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
}

function stepMatch(m, dt) {
  const speed = 320;
  const jumpV = -520;
  const gravity = 1400;
  const rockSpeed = 680;

  const hitboxW = 46,
    hitboxH = 62;

  function rectHit(px, py, rx, ry, rw, rh) {
    return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
  }

  const left = m.players.left;
  const right = m.players.right;

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
      pl.cooldown = 0.55;

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

    // bounds (각자 반쪽)
    if (side === "left") pl.x = clamp(pl.x, 40, m.W / 2 - 40);
    else pl.x = clamp(pl.x, m.W / 2 + 40, m.W - 40);

    // ground
    if (pl.y >= m.groundY) {
      pl.y = m.groundY;
      pl.vy = 0;
      pl.onGround = true;
    }
  }

  // integrate rocks & collisions
  for (const rock of m.rocks) {
    if (!rock.alive) continue;

    rock.x += rock.vx * dt;
    rock.y += rock.vy * dt;
    rock.vy += gravity * 0.35 * dt;

    // out of bounds
    if (rock.x < -100 || rock.x > m.W + 100 || rock.y > m.H + 200) {
      rock.alive = false;
      continue;
    }

    // hit players
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

        if (pl.hp <= 0 && !m.over) {
          m.over = true;
          m.winnerId = pl.id === left.id ? right.id : left.id;
        }
      }
    }
  }

  m.rocks = m.rocks.filter((r) => r.alive);

  // end match
  if (m.over) {
    const room = m.room;
    const winnerId = m.winnerId;
    const loserId = winnerId === left.id ? right.id : left.id;

    const pW = DB.players[winnerId];
    const pL = DB.players[loserId];

    if (m.ranked && pW && pL) updateRating(pW, pL, winnerId);

    awardAfterMatch(winnerId, "win", m.ranked);
    awardAfterMatch(loserId, "lose", m.ranked);

    rebuildLeaderboard();

    io.to(room).emit("match_over", {
      winnerId,
      ranked: m.ranked,
      profiles: {
        [winnerId]: pW ? publicProfile(pW) : null,
        [loserId]: pL ? publicProfile(pL) : null,
      },
      leaderboard: DB.leaderboard,
    });

    MATCHES.delete(room);
  }
}

// tick loop
let lastTick = nowMs();
setInterval(() => {
  const t = nowMs();
  const dt = clamp((t - lastTick) / 1000, 0, 0.05);
  lastTick = t;

  for (const m of MATCHES.values()) {
    if (!m.over) stepMatch(m, dt);

    io.to(m.room).emit("state", {
      t,
      W: m.W,
      H: m.H,
      groundY: m.groundY,
      players: m.players,
      rocks: m.rocks,
    });
  }
}, 1000 / 30);

// -------------------- Shop catalog --------------------
const SHOP = [
  { id: "default", name: "기본 바위", price: 0, color: "#9aa0a6", trail: 0.15 },
  { id: "ruby", name: "루비 바위", price: 120, color: "#ff4b4b", trail: 0.22 },
  { id: "emerald", name: "에메랄드 바위", price: 160, color: "#2ee59d", trail: 0.22 },
  { id: "sapphire", name: "사파이어 바위", price: 200, color: "#4b7bff", trail: 0.24 },
  { id: "gold", name: "골드 바위", price: 260, color: "#ffd34b", trail: 0.26 },
];

// -------------------- Socket handlers --------------------
io.on("connection", (socket) => {
  socket.data.inMatch = false;
  socket.data.room = null;
  socket.data.playerId = null;
  socket.data.name = "Player";

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

    tryMatch(ranked ? rankedQueue : casualQueue, ranked);
  });

  socket.on("queue_leave", () => {
    removeFromQueue(casualQueue, socket.id);
    removeFromQueue(rankedQueue, socket.id);
  });

  socket.on("input", (input) => {
    const pid = socket.data.playerId;
    const room = socket.data.room;
    if (!pid || !room) return;

    const m = MATCHES.get(room);
    if (!m) return;

    const safe = {
      l: !!input?.l,
      r: !!input?.r,
      j: !!input?.j,
      shoot: !!input?.shoot,
    };
    m.inputs[pid] = safe;
  });

  socket.on("disconnect", () => {
    removeFromQueue(casualQueue, socket.id);
    removeFromQueue(rankedQueue, socket.id);

    const room = socket.data.room;
    if (room && MATCHES.has(room)) {
      const m = MATCHES.get(room);
      if (m && !m.over) {
        m.over = true;
        const leftId = m.players.left.id;
        const rightId = m.players.right.id;
        const leaverId = socket.data.playerId;
        m.winnerId = leaverId === leftId ? rightId : leftId;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
