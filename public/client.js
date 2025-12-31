import { clamp } from "./shared.js";

const socket = io();
const el = (id) => document.getElementById(id);

// -------------------- Views --------------------
const views = {
  lobby: el("viewLobby"),
  shop: el("viewShop"),
  leader: el("viewLeader"),
  how: el("viewHow"),
  game: el("viewGame"),
};

function show(name) {
  for (const k of Object.keys(views)) {
    views[k].classList.toggle("hidden", k !== name);
  }
}

// -------------------- Canvas --------------------
const canvas = el("game");
const ctx = canvas.getContext("2d");

// -------------------- Profile / Shop / Leaderboard --------------------
let profile = null;
let shop = [];
let leaderboard = [];

const nameInput = el("nameInput");
const saveNameBtn = el("saveNameBtn");
const statsBar = el("statsBar");
const btnRanked = el("btnRanked");
const rankLockMsg = el("rankLockMsg");
const shopList = el("shopList");
const leaderList = el("leaderList");

function uid() {
  const key = "owl_uid";
  let v = localStorage.getItem(key);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(key, v);
  }
  return v;
}
function savedName() {
  const key = "owl_name";
  let v = localStorage.getItem(key);
  if (!v) v = "Player";
  return v;
}
nameInput.value = savedName();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function updateTopBar() {
  if (!profile) {
    statsBar.textContent = "연결 중...";
    btnRanked.textContent = "랭크전 플레이 하기 (Lv15)";
    return;
  }
  const lvl = profile.level ?? 1;
  const tier = profile.tier ?? "—";
  statsBar.textContent =
    `Lv.${lvl} | XP ${profile.xp} | 루비 ${profile.rubies} | ` +
    `레이팅 ${profile.rating} (${tier}) | W:${profile.wins} L:${profile.losses}`;

  btnRanked.textContent = (lvl >= 15)
    ? "랭크전 플레이 하기"
    : `랭크전 플레이 하기 (Lv15 필요: 현재 Lv.${lvl})`;
}

function updateRankLockMsg() {
  if (!profile) return;
  const lvl = profile.level ?? 1;
  rankLockMsg.textContent = (lvl >= 15)
    ? "✅ 랭크전 가능!"
    : `🔒 랭크전은 Lv15부터 (현재 Lv.${lvl})`;
}

function renderShop() {
  if (!profile) return;
  shopList.innerHTML = "";

  for (const item of shop) {
    const owned = profile.ownedSkins?.includes(item.id);
    const equipped = profile.rockSkin === item.id;

    const div = document.createElement("div");
    div.className = "shopItem";

    const left = document.createElement("div");
    left.innerHTML = `
      <div style="font-weight:800">${escapeHtml(item.name)}</div>
      <div class="badge">가격: ${item.price} 루비</div>
      <div style="margin-top:8px">
        <span class="pill">색</span>
        <span class="pill" style="border-color:${item.color}; color:${item.color}">${item.color}</span>
      </div>
      <div class="badge" style="margin-top:6px">${owned ? "보유함" : "미보유"}</div>
    `;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.flexDirection = "column";
    right.style.gap = "8px";
    right.style.alignItems = "flex-end";

    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = owned ? (equipped ? "장착됨" : "장착하기") : "구매";

    btn.onclick = async () => {
      if (!owned) {
        socket.emit("shop_buy", item.id, (res) => {
          if (!res?.ok) {
            alert(res?.error === "no_rubies" ? "루비가 부족해!" : "구매 실패");
            return;
          }
          profile = res.profile;
          updateTopBar();
          renderShop();
        });
      } else if (!equipped) {
        socket.emit("shop_equip", item.id, (res) => {
          if (!res?.ok) return alert("장착 실패");
          profile = res.profile;
          updateTopBar();
          renderShop();
        });
      }
    };

    right.appendChild(btn);
    if (equipped) {
      const tag = document.createElement("div");
      tag.className = "badge";
      tag.textContent = "현재 사용중";
      right.appendChild(tag);
    }

    div.appendChild(left);
    div.appendChild(right);
    shopList.appendChild(div);
  }
}

function renderLeaderboard() {
  leaderList.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "leader";

  (leaderboard || []).slice(0, 30).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div><b>#${i + 1}</b> ${escapeHtml(p.name)} <span class="muted tiny">(Lv.${p.level})</span></div>
      <div><b>${p.rating}</b> <span class="muted tiny">${escapeHtml(p.tier || "")} W:${p.wins} L:${p.losses}</span></div>
    `;
    wrap.appendChild(row);
  });

  leaderList.appendChild(wrap);
}

// -------------------- Buttons --------------------
el("btnPlay").onclick = () => show("lobby");
el("btnShop").onclick = () => { show("shop"); renderShop(); };
el("btnLeader").onclick = () => { show("leader"); renderLeaderboard(); };
el("btnHow").onclick = () => show("how");
el("btnRanked").onclick = () => show("lobby");

el("btnLocal2P").onclick = () => startLocal2P();
el("btnVsAI").onclick = () => startVsAI();
el("btnCasualMM").onclick = () => joinQueue(false);
el("btnRankMM").onclick = () => joinQueue(true);

const hudLeft = el("hudLeft");
const hudMid = el("hudMid");
const hudRight = el("hudRight");

function setMatchMsg(text) {
  el("matchMsg").textContent = text || "";
}

// -------------------- Save Name --------------------
saveNameBtn.onclick = () => {
  const v = nameInput.value.trim().slice(0, 16) || "Player";
  localStorage.setItem("owl_name", v);
  handshake();
};

// -------------------- Handshake --------------------
function handshake() {
  socket.emit("hello", {
    profile: { id: uid(), name: savedName() },
  }, (res) => {
    if (!res?.ok) {
      alert("서버 연결 실패");
      return;
    }
    profile = res.profile;
    shop = res.shop || [];
    leaderboard = res.leaderboard || [];

    updateTopBar();
    updateRankLockMsg();
    renderShop();
    renderLeaderboard();
  });
}
handshake();

// ======================================================================
// ✅ FILE SOUND SYSTEM (mp3/wav) - low latency + fallback
// ======================================================================

// 1) 여기 파일명만 바꾸면 “원하는 사운드”로 즉시 교체됨
const SOUND_FILES = {
  whoosh: ["/sfx/whoosh.mp3", "/sfx/whoosh.wav"],
  hit:    ["/sfx/hit.mp3", "/sfx/hit.wav"],
  impact: ["/sfx/impact.mp3", "/sfx/impact.wav"],
};

// 2) 볼륨(너 취향대로 조절)
const SOUND_VOL = {
  whoosh: 0.80,
  hit:    0.95,
  impact: 0.70,
};

class SoundBank {
  constructor() {
    this.ac = null;
    this.master = null;
    this.buffers = new Map(); // name -> AudioBuffer
    this.ready = false;
    this.loading = false;
  }

  ensureContext() {
    if (!this.ac) {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ac.createGain();
      this.master.gain.value = 1.0;
      this.master.connect(this.ac.destination);
    }
    return this.ac;
  }

  async unlockAndPreload() {
    if (this.ready || this.loading) return;
    this.loading = true;

    const ac = this.ensureContext();
    try { await ac.resume(); } catch {}

    // 로드 시도 (실패하면 fallback로 넘어감)
    const names = Object.keys(SOUND_FILES);
    await Promise.all(names.map((name) => this.loadAny(name)));

    this.ready = true;
    this.loading = false;
  }

  async loadAny(name) {
    const list = SOUND_FILES[name] || [];
    for (const url of list) {
      try {
        const buf = await this.fetchDecode(url);
        if (buf) {
          this.buffers.set(name, buf);
          return true;
        }
      } catch {}
    }
    return false;
  }

  async fetchDecode(url) {
    const ac = this.ensureContext();
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return await ac.decodeAudioData(arr);
  }

  play(name, { vol = 1, rate = 1 } = {}) {
    // 버퍼가 있으면 WebAudio로 저지연 재생
    const ac = this.ac;
    const buf = this.buffers.get(name);
    if (ac && buf) {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;

      const g = ac.createGain();
      g.gain.value = vol;

      src.connect(g);
      g.connect(this.master);
      src.start();
      return;
    }

    // fallback: HTMLAudio (로딩 실패/미지원 대비)
    const list = SOUND_FILES[name] || [];
    const url = list.find(Boolean);
    if (!url) return;
    try {
      const a = new Audio(url);
      a.volume = Math.max(0, Math.min(1, vol));
      a.currentTime = 0;
      a.play().catch(() => {});
    } catch {}
  }
}

const SFX = new SoundBank();

// 사용자 입력(첫 키/클릭) 때 자동 언락 + 프리로드
function resumeAudio() {
  SFX.unlockAndPreload();
}

// “플래시겜 감성” 살리는 미세 랜덤(너무 과하면 촌스러워져서 최소만)
function playWhoosh() {
  const rate = 0.98 + Math.random() * 0.06;
  SFX.play("whoosh", { vol: SOUND_VOL.whoosh, rate });
}
function playHit() {
  const rate = 0.98 + Math.random() * 0.05;
  SFX.play("hit", { vol: SOUND_VOL.hit, rate });
}
function playImpact() {
  const rate = 0.97 + Math.random() * 0.06;
  SFX.play("impact", { vol: SOUND_VOL.impact, rate });
}

// 서버 이벤트 사운드
socket.on("sfx_shoot", () => { playWhoosh(); playImpact(); });
socket.on("sfx_hit", () => { playHit(); });

// -------------------- Render helpers --------------------
function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function drawGround(W, H, groundY) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, groundY, W, H - groundY);

  ctx.fillStyle = "rgba(91,214,255,0.08)";
  ctx.fillRect(W / 2 - 2, 0, 4, H);
  ctx.restore();
}
function drawOwl(x, y, side, hp) {
  ctx.save();

  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.ellipse(x, y + 6, 28, 10, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = side === "left" ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.82)";
  roundRect(x - 24, y - 56, 48, 56, 14);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.95)";
  roundRect(x - 26, y - 92, 52, 44, 16);
  ctx.fill();

  ctx.fillStyle = "#0b0f14";
  ctx.beginPath(); ctx.arc(x - 10, y - 74, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 10, y - 74, 5, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = "rgba(255,211,75,0.95)";
  ctx.beginPath();
  ctx.moveTo(x, y - 66);
  ctx.lineTo(x - 5, y - 58);
  ctx.lineTo(x + 5, y - 58);
  ctx.closePath();
  ctx.fill();

  // HP bar (max 5 기준)
  const maxHP = 5;
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  roundRect(x - 30, y - 112, 60, 8, 6); ctx.fill();
  ctx.fillStyle = "rgba(91,214,255,0.85)";
  roundRect(x - 30, y - 112, (60 * clamp(hp / maxHP, 0, 1)), 8, 6); ctx.fill();

  ctx.restore();
}
function drawRock(rock, skinColor) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(rock.x, rock.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = skinColor || "#9aa0a6";
  ctx.fill();
  ctx.restore();
}
function skinColor(id) {
  const item = (shop || []).find((s) => s.id === id) || (shop || []).find((s) => s.id === "default");
  return item?.color || "#9aa0a6";
}

// -------------------- Exit --------------------
el("btnExitGame").onclick = () => {
  stopGame();
  socket.emit("queue_leave"); // 온라인이면 서버가 기권패 처리
  show("lobby");
  setMatchMsg("");
};

function stopGame() {
  running = false;
  mode = "none";
  online.inMatch = false;
}

// -------------------- Offline reward (AI only) --------------------
function requestOfflineReward(result) {
  socket.emit("offline_result", { result }, (res) => {
    if (!res?.ok) return;
    if (res.profile) profile = res.profile;
    if (res.leaderboard) leaderboard = res.leaderboard;

    updateTopBar();
    updateRankLockMsg();
    renderShop();
    renderLeaderboard();
  });
}

// -------------------- Local/AI game core --------------------
let mode = "none"; // "local2p" | "ai" | "online"
let running = false;

function startLocal2P() {
  show("game");
  setMatchMsg("로컬 2P 시작! (P1: A/D/W + R) (P2: ←/→/↑ + Enter)");
  mode = "local2p";
  startOfflineSim({ ai: false });
}

function startVsAI() {
  show("game");
  setMatchMsg("AI전 시작! (A/D/W 이동, R 발사)");
  mode = "ai";
  startOfflineSim({ ai: true });
}

function startOfflineSim({ ai }) {
  running = true;

  const W = canvas.width, H = canvas.height, groundY = 360;
  const state = {
    W, H, groundY,
    left:  { x: 120, y: groundY, vx: 0, vy: 0, onGround: true, hp: 5, cd: 0 },
    right: { x: W - 120, y: groundY, vx: 0, vy: 0, onGround: true, hp: 5, cd: 0 },
    rocks: [],
    shake: 0,
  };

  const keys = {};
  window.onkeydown = (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === "Enter") keys["enter"] = true;
    resumeAudio();
  };
  window.onkeyup = (e) => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === "Enter") keys["enter"] = false;
  };

  let last = performance.now();
  function loop(t) {
    if (!running || mode === "online") return;
    const dt = clamp((t - last) / 1000, 0, 0.05);
    last = t;

    stepOffline(state, keys, dt, ai);
    renderOffline(state);

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function updatePlayer(p, dt, gravity, jumpV, speed, L, R, J, S, dir, s) {
  let ax = 0;
  if (L) ax -= 1;
  if (R) ax += 1;
  p.vx = ax * speed;

  if (J && p.onGround) {
    p.vy = jumpV;
    p.onGround = false;
    playImpact();
  }

  // 공속(발사쿨) 살짝 느리게
  p.cd = Math.max(0, p.cd - dt);

  if (S && p.cd <= 0) {
    p.cd = 0.72;
    s.rocks.push({
      x: p.x + dir * 34,
      y: p.y - 40,
      vx: dir * 620,
      vy: -40,
      owner: dir === 1 ? "left" : "right",
      alive: true,
    });
    playWhoosh();
    playImpact();
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.vy += gravity * dt;

  if (p.y >= s.groundY) {
    p.y = s.groundY;
    p.vy = 0;
    p.onGround = true;
  }
}

function hitPlayer(r, p) {
  const hitboxW = 46, hitboxH = 62;
  const rx = p.x - hitboxW / 2;
  const ry = p.y - hitboxH;
  return (r.x >= rx && r.x <= rx + hitboxW && r.y >= ry && r.y <= ry + hitboxH);
}

function stepOffline(s, keys, dt, ai) {
  const speed = 320, jumpV = -520, gravity = 1400;

  const p1L = !!keys["a"];
  const p1R = !!keys["d"];
  const p1J = !!keys["w"];
  const p1S = !!keys["r"];

  const p2L = !!keys["arrowleft"];
  const p2R = !!keys["arrowright"];
  const p2J = !!keys["arrowup"];
  const p2S = !!keys["enter"];

  let aiL = false, aiR = false, aiJ = false, aiS = false;
  if (ai) {
    const targetX = s.left.x;
    if (s.right.x > targetX + 30) aiL = true;
    if (s.right.x < targetX - 30) aiR = true;
    if (Math.random() < 0.01 && s.right.onGround) aiJ = true;
    if (s.right.cd <= 0 && Math.abs(s.right.x - targetX) < 260) aiS = true;
  }

  updatePlayer(s.left, dt, gravity, jumpV, speed, p1L, p1R, p1J, p1S, +1, s);
  if (ai) updatePlayer(s.right, dt, gravity, jumpV, speed, aiL, aiR, aiJ, aiS, -1, s);
  else updatePlayer(s.right, dt, gravity, jumpV, speed, p2L, p2R, p2J, p2S, -1, s);

  s.left.x = clamp(s.left.x, 40, s.W / 2 - 40);
  s.right.x = clamp(s.right.x, s.W / 2 + 40, s.W - 40);

  for (const r of s.rocks) {
    if (!r.alive) continue;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.vy += gravity * 0.35 * dt;

    if (r.x < -100 || r.x > s.W + 100 || r.y > s.H + 200) r.alive = false;

    if (r.alive && r.owner === "left") {
      if (hitPlayer(r, s.right)) {
        r.alive = false; s.right.hp -= 1;
        s.right.vy = -220; s.right.x += 18;
        s.shake = 0.18;
        playHit();
      }
    } else if (r.alive && r.owner === "right") {
      if (hitPlayer(r, s.left)) {
        r.alive = false; s.left.hp -= 1;
        s.left.vy = -220; s.left.x -= 18;
        s.shake = 0.18;
        playHit();
      }
    }
  }
  s.rocks = s.rocks.filter(r => r.alive);

  if (s.left.hp <= 0 || s.right.hp <= 0) {
    const p1Win = (s.right.hp <= 0);

    if (mode === "ai") {
      requestOfflineReward(p1Win ? "win" : "lose");
    }

    setMatchMsg(p1Win ? "승리 하셨습니다 ! 🎉" : "패배 하였습니다..! 😥");
    running = false;
  }
}

function renderOffline(s) {
  clear();

  if (s.shake > 0) {
    s.shake = Math.max(0, s.shake - 0.02);
    const amt = s.shake * 14;
    ctx.save();
    ctx.translate((Math.random() * 2 - 1) * amt, (Math.random() * 2 - 1) * amt);
  }

  drawGround(s.W, s.H, s.groundY);

  const myColor = skinColor(profile?.rockSkin || "default");
  const enemyColor = "#9aa0a6";
  for (const r of s.rocks) drawRock(r, r.owner === "left" ? myColor : enemyColor);

  drawOwl(s.left.x, s.left.y, "left", s.left.hp);
  drawOwl(s.right.x, s.right.y, "right", s.right.hp);

  hudLeft.textContent = `P1 HP: ${s.left.hp}`;
  hudRight.textContent = `P2 HP: ${s.right.hp}`;
  hudMid.textContent = mode === "ai" ? "AI전 (보상 저장됨)" : "로컬 2P";

  if (s.shake > 0) ctx.restore();
}

// -------------------- Online mode --------------------
let online = {
  inMatch: false,
  ranked: false,
  room: null,
  myId: null,
  mySide: null,
  opponentName: "",
};

let netState = null;
let sendInputTimer = 0;

async function joinQueue(ranked) {
  if (!profile) return;

  socket.emit("queue_join", { ranked }, (res) => {
    if (!res?.ok) {
      if (res?.error === "rank_locked") {
        alert(`랭크전은 Lv${res.needLevel}부터 가능해!`);
      } else {
        alert("매칭 실패");
      }
      return;
    }
    show("game");
    setMatchMsg(ranked ? "랭크 매칭 중..." : "일반 매칭 중...");
    startOnlineShell(ranked);
  });
}

function startOnlineShell(ranked) {
  mode = "online";
  running = true;
  online.inMatch = false;
  online.ranked = ranked;
  online.room = null;
  online.myId = profile?.id;

  const keys = {};
  window.onkeydown = (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === "Enter") keys["enter"] = true;
    resumeAudio();
  };
  window.onkeyup = (e) => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === "Enter") keys["enter"] = false;
  };

  let last = performance.now();
  function loop(t) {
    if (!running || mode !== "online") return;
    const dt = clamp((t - last) / 1000, 0, 0.05);
    last = t;

    sendInputTimer += dt;
    if (sendInputTimer >= 0.05) {
      sendInputTimer = 0;
      socket.emit("input", {
        l: !!keys["a"],
        r: !!keys["d"],
        j: !!keys["w"],
        shoot: !!keys["r"],
      });
    }

    renderOnline();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

socket.on("match_start", (data) => {
  online.inMatch = true;
  online.room = data.room;
  online.ranked = data.ranked;

  const me = data.players.find(p => p.playerId === online.myId);
  online.mySide = me?.side || "left";

  const opp = data.players.find(p => p.playerId !== online.myId);
  online.opponentName = opp?.name || "Opponent";

  setMatchMsg((online.ranked ? "랭크전" : "일반전") + ` 시작! 상대: ${online.opponentName}`);
});

socket.on("state", (s) => {
  netState = s;
});

socket.on("match_over", (data) => {
  const win = data.winnerId === online.myId;
  setMatchMsg(win ? "승리 하셨습니다 ! 🎉" : "패배 하였습니다..! 😥");

  const my = data.profiles?.[online.myId];
  if (my) profile = my;
  leaderboard = data.leaderboard || leaderboard;

  updateTopBar();
  updateRankLockMsg();
  renderShop();
  renderLeaderboard();

  online.inMatch = false;
});

function renderOnline() {
  clear();
  const s = netState;
  if (!s) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "16px ui-sans-serif";
    ctx.fillText("상태 동기화 중...", 18, 28);
    ctx.restore();
    return;
  }

  drawGround(s.W, s.H, s.groundY);

  const left = s.players.left;
  const right = s.players.right;

  const myColor = skinColor(profile?.rockSkin || "default");
  for (const r of s.rocks) {
    const col = (r.owner === online.myId) ? myColor : "#9aa0a6";
    drawRock(r, col);
  }

  drawOwl(left.x, left.y, "left", left.hp);
  drawOwl(right.x, right.y, "right", right.hp);

  const myIsLeft = left.id === online.myId;
  const myHP = myIsLeft ? left.hp : right.hp;
  const opHP = myIsLeft ? right.hp : left.hp;

  // 서버가 라운드/스코어를 안 보내도 절대 오류 안 나게
  const round = s.round ?? 1;
  const maxRounds = s.maxRounds ?? 7;
  const scoreL = s.scoreL ?? 0;
  const scoreR = s.scoreR ?? 0;

  const roundText = `R${round}/${maxRounds} | ${scoreL}:${scoreR} (4선승)`;

  hudLeft.textContent = `내 HP: ${myHP}`;
  hudRight.textContent = `${online.opponentName} HP: ${opHP}`;
  hudMid.textContent = (online.ranked ? "온라인 랭크" : "온라인 일반") + " • " + roundText;
}
