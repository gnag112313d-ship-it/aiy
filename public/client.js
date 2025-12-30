import { clamp, xpToLevel } from "./shared.js";

const socket = io();

const el = (id) => document.getElementById(id);

const views = {
  lobby: el("viewLobby"),
  shop: el("viewShop"),
  leader: el("viewLeader"),
  how: el("viewHow"),
  game: el("viewGame")
};

function show(name) {
  for (const k of Object.keys(views)) {
    views[k].classList.toggle("hidden", k !== name);
  }
}

const canvas = el("game");
const ctx = canvas.getContext("2d");

// ---------- Profile / Shop / Leaderboard ----------
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

function tierText(p) {
  if (!p) return "";
  if (!p.tier) return "";
  if (p.division == null) return `${p.tier}`; // 불멸 등
  return `${p.tier} ${p.division}`;
}

function updateTopBar() {
  if (!profile) {
    statsBar.textContent = "연결 중...";
    btnRanked.textContent = "랭크전 플레이 하기 (Lv15)";
    return;
  }
  const lvl = profile.level;
  statsBar.textContent =
    `Lv.${lvl} | XP ${profile.xp} | 루비 ${profile.rubies} | 티어 ${tierText(profile)} | 레이팅 ${profile.rating} (W:${profile.wins} L:${profile.losses})`;

  btnRanked.textContent = (lvl >= 15)
    ? "랭크전 플레이 하기"
    : `랭크전 플레이 하기 (Lv15 필요: 현재 Lv.${lvl})`;
}

function renderShop() {
  if (!profile) return;
  shopList.innerHTML = "";

  for (const item of shop) {
    const owned = profile.ownedSkins.includes(item.id);
    const equipped = profile.rockSkin === item.id;

    const div = document.createElement("div");
    div.className = "shopItem";

    const left = document.createElement("div");
    left.innerHTML = `
      <div style="font-weight:800">${item.name}</div>
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

  leaderboard.slice(0, 30).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div><b>#${i + 1}</b> ${escapeHtml(p.name)} <span class="muted tiny">(Lv.${p.level})</span></div>
      <div><b>${p.rating}</b> <span class="muted tiny">${p.tier}${p.division ? " " + p.division : ""} | W:${p.wins} L:${p.losses}</span></div>
    `;
    wrap.appendChild(row);
  });

  leaderList.appendChild(wrap);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

// ---------- Views buttons ----------
el("btnPlay").onclick = () => show("lobby");
el("btnShop").onclick = () => { show("shop"); renderShop(); };
el("btnLeader").onclick = () => { show("leader"); renderLeaderboard(); };
el("btnHow").onclick = () => show("how");

el("btnLocal2P").onclick = () => startLocal2P();
el("btnVsAI").onclick = () => startVsAI();
el("btnCasualMM").onclick = () => joinQueue(false);
el("btnRankMM").onclick = () => joinQueue(true);

el("btnRanked").onclick = () => show("lobby");

// ---------- Name save ----------
saveNameBtn.onclick = () => {
  const v = nameInput.value.trim().slice(0, 16) || "Player";
  localStorage.setItem("owl_name", v);
  handshake();
};

// ---------- Handshake ----------
function handshake() {
  socket.emit("hello", {
    profile: { id: uid(), name: savedName() }
  }, (res) => {
    if (!res?.ok) {
      alert("서버 연결 실패");
      return;
    }
    profile = res.profile;
    shop = res.shop;
    leaderboard = res.leaderboard;

    updateTopBar();
    updateRankLockMsg();
    renderShop();
    renderLeaderboard();
  });
}
handshake();

function updateRankLockMsg() {
  if (!profile) return;
  const lvl = profile.level;
  rankLockMsg.textContent = (lvl >= 15)
    ? "✅ 랭크전 가능!"
    : `🔒 랭크전은 Lv15부터 (현재 Lv.${lvl})`;
}

// ---------- Matchmaking ----------
let online = {
  inMatch: false,
  ranked: false,
  room: null,
  myId: null,
  mySide: null,
  opponentName: "",
};

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

function setMatchMsg(text) {
  el("matchMsg").textContent = text || "";
}

// ---------- Audio (WebAudio synth) ----------
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playWhoosh() {
  const ac = getAudio();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(680, ac.currentTime);
  o.frequency.exponentialRampToValueAtTime(160, ac.currentTime + 0.12);
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.14);
  o.connect(g); g.connect(ac.destination);
  o.start(); o.stop(ac.currentTime + 0.16);
}
function playHit() {
  const ac = getAudio();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(120, ac.currentTime);
  o.frequency.exponentialRampToValueAtTime(55, ac.currentTime + 0.10);
  g.gain.setValueAtTime(0.0001, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.35, ac.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.12);
  o.connect(g); g.connect(ac.destination);
  o.start(); o.stop(ac.currentTime + 0.14);
}
function playImpact() {
  const ac = getAudio();
  const bufferSize = 0.06 * ac.sampleRate;
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random()*2 - 1) * Math.exp(-i / (bufferSize / 6));
  }
  const src = ac.createBufferSource();
  const g = ac.createGain();
  g.gain.value = 0.35;
  src.buffer = buffer;
  src.connect(g); g.connect(ac.destination);
  src.start();
}

socket.on("sfx_shoot", () => { playWhoosh(); playImpact(); });
socket.on("sfx_hit", () => { playHit(); });

// ---------- Game rendering helpers ----------
function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawGround(W, H, groundY) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, groundY, W, H - groundY);

  ctx.fillStyle = "rgba(91,214,255,0.08)";
  ctx.fillRect(W/2 - 2, 0, 4, H);
  ctx.restore();
}

function drawOwl(x, y, side, hp, maxHp=5) {
  ctx.save();

  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.ellipse(x, y + 6, 28, 10, 0, 0, Math.PI*2);
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
  ctx.beginPath(); ctx.arc(x - 10, y - 74, 5, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 10, y - 74, 5, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = "rgba(255,211,75,0.95)";
  ctx.beginPath();
  ctx.moveTo(x, y - 66);
  ctx.lineTo(x - 5, y - 58);
  ctx.lineTo(x + 5, y - 58);
  ctx.closePath();
  ctx.fill();

  // HP bar
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  roundRect(x - 30, y - 112, 60, 8, 6); ctx.fill();
  ctx.fillStyle = "rgba(91,214,255,0.85)";
  roundRect(x - 30, y - 112, (60 * clamp(hp/maxHp, 0, 1)), 8, 6); ctx.fill();

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

function drawRock(rock, skinColor) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(rock.x, rock.y, 10, 0, Math.PI*2);
  ctx.fillStyle = skinColor || "#9aa0a6";
  ctx.fill();
  ctx.restore();
}

// ---------- Local/AI game core ----------
let mode = "none"; // "local2p" | "ai" | "online"
let running = false;

const hudLeft = el("hudLeft");
const hudMid = el("hudMid");
const hudRight = el("hudRight");

el("btnExitGame").onclick = () => {
  stopGame();
  socket.emit("queue_leave");
  show("lobby");
  setMatchMsg("");
};

function stopGame() {
  running = false;
  mode = "none";
  online.inMatch = false;
}

function startLocal2P() {
  show("game");
  setMatchMsg("로컬 2P 시작! (P1: A/D/W + R) (P2: ←/→/↑ + Enter)");
  mode = "local2p";
  startOfflineSim({ ai:false });
}

function startVsAI() {
  show("game");
  setMatchMsg("AI전 시작! (A/D/W 이동, R 발사)");
  mode = "ai";
  startOfflineSim({ ai:true });
}

function makeSkinMap() {
  const map = {};
  for (const s of shop) map[s.id] = s;
  return map;
}

function skinColor(id) {
  const item = shop.find(s => s.id === id) || shop.find(s=>s.id==="default");
  return item?.color || "#9aa0a6";
}

// offline sim state
function startOfflineSim({ ai }) {
  running = true;

  const W = canvas.width, H = canvas.height, groundY = 360;
  const RULES = { hitsToWinRound: 5, maxRounds: 7, winRounds: 4, shootCooldown: 0.65 };

  const state = {
    W, H, groundY,
    rules: RULES,
    round: 1,
    score: { left: 0, right: 0 },

    left:  { x:120, y:groundY, vx:0, vy:0, onGround:true, hp:RULES.hitsToWinRound, cd:0 },
    right: { x:W-120,y:groundY, vx:0, vy:0, onGround:true, hp:RULES.hitsToWinRound, cd:0 },
    rocks: [],
    shake: 0,

    ai,
  };

  const keys = {};
  window.onkeydown = (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === "Enter") keys["enter"]=true;
    resumeAudio();
  };
  window.onkeyup = (e) => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === "Enter") keys["enter"]=false;
  };

  function resumeAudio(){ try{ getAudio().resume(); }catch{} }

  let last = performance.now();
  function loop(t) {
    if (!running || mode === "online") return;
    const dt = clamp((t - last) / 1000, 0, 0.05);
    last = t;

    stepOffline(state, keys, dt);
    renderOffline(state);

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function resetOfflineRound(s) {
  s.rocks = [];
  s.left.x = 120; s.left.y = s.groundY; s.left.vx = 0; s.left.vy = 0; s.left.onGround = true; s.left.hp = s.rules.hitsToWinRound; s.left.cd=0;
  s.right.x = s.W-120; s.right.y = s.groundY; s.right.vx = 0; s.right.vy = 0; s.right.onGround = true; s.right.hp = s.rules.hitsToWinRound; s.right.cd=0;
}

function awardOfflineToServer(result) {
  if (!profile) return;
  socket.emit("offline_award", { result }, (res) => {
    if (!res?.ok) return;
    profile = res.profile;
    leaderboard = res.leaderboard || leaderboard;
    updateTopBar();
    updateRankLockMsg();
  });
}

function stepOffline(s, keys, dt) {
  const speed = 320, jumpV = -520, gravity = 1400;

  // P1
  const p1L = !!keys["a"];
  const p1R = !!keys["d"];
  const p1J = !!keys["w"];
  const p1S = !!keys["r"];

  // P2
  const p2L = !!keys["arrowleft"];
  const p2R = !!keys["arrowright"];
  const p2J = !!keys["arrowup"];
  const p2S = !!keys["enter"];

  // AI (오른쪽)
  let aiL=false, aiR=false, aiJ=false, aiS=false;
  if (s.ai) {
    const targetX = s.left.x;
    if (s.right.x > targetX + 30) aiL = true;
    if (s.right.x < targetX - 30) aiR = true;
    if (Math.random() < 0.01 && s.right.onGround) aiJ = true;
    if (s.right.cd <= 0 && Math.abs(s.right.x - targetX) < 240) aiS = true;
  }

  updatePlayer(s.left, dt, gravity, jumpV, speed, p1L, p1R, p1J, p1S, +1, s);
  if (s.ai) updatePlayer(s.right, dt, gravity, jumpV, speed, aiL, aiR, aiJ, aiS, -1, s);
  else updatePlayer(s.right, dt, gravity, jumpV, speed, p2L, p2R, p2J, p2S, -1, s);

  s.left.x = clamp(s.left.x, 40, s.W/2 - 40);
  s.right.x = clamp(s.right.x, s.W/2 + 40, s.W - 40);

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

  // 라운드 종료 체크
  if (s.left.hp <= 0 || s.right.hp <= 0) {
    const roundWinner = (s.right.hp <= 0) ? "left" : "right";
    s.score[roundWinner] += 1;

    // 4선승 or 7라운드 종료
    const done = (s.score.left >= s.rules.winRounds || s.score.right >= s.rules.winRounds || s.round >= s.rules.maxRounds);

    if (done) {
      const finalWinner = (s.score.left > s.score.right) ? "left" : "right";
      const winText = (finalWinner === "left") ? "P1 최종 승리!" : (s.ai ? "AI 최종 승리!" : "P2 최종 승리!");
      setMatchMsg(winText + " (로비로 나가서 다시 시작 가능)");

      // ★ 오프라인도 XP/루비 저장: 로그인한 계정(P1) 기준
      if (finalWinner === "left") awardOfflineToServer("win");
      else awardOfflineToServer("lose");

      running = false;
      return;
    }

    // 다음 라운드
    s.round += 1;
    resetOfflineRound(s);
  }
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

  p.cd = Math.max(0, p.cd - dt);

  if (S && p.cd <= 0) {
    p.cd = s.rules.shootCooldown; // 공속 살짝 느리게
    s.rocks.push({
      x: p.x + dir * 34,
      y: p.y - 40,
      vx: dir * 680,
      vy: -40,
      owner: dir === 1 ? "left" : "right",
      alive: true
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
  const rx = p.x - hitboxW/2;
  const ry = p.y - hitboxH;
  return (r.x >= rx && r.x <= rx+hitboxW && r.y >= ry && r.y <= ry+hitboxH);
}

function renderOffline(s) {
  clear();

  if (s.shake > 0) {
    s.shake = Math.max(0, s.shake - 0.02);
    const amt = s.shake * 14;
    ctx.save();
    ctx.translate((Math.random()*2-1)*amt, (Math.random()*2-1)*amt);
  }

  drawGround(s.W, s.H, s.groundY);

  const myColor = skinColor(profile?.rockSkin || "default");
  const enemyColor = "#9aa0a6";
  for (const r of s.rocks) drawRock(r, r.owner==="left" ? myColor : enemyColor);

  drawOwl(s.left.x, s.left.y, "left", s.left.hp, s.rules.hitsToWinRound);
  drawOwl(s.right.x, s.right.y, "right", s.right.hp, s.rules.hitsToWinRound);

  hudLeft.textContent = `P1 HP: ${s.left.hp} | 라운드승: ${s.score.left}`;
  hudRight.textContent = `${s.ai ? "AI" : "P2"} HP: ${s.right.hp} | 라운드승: ${s.score.right}`;
  hudMid.textContent = `${s.ai ? "AI전" : "로컬 2P"} | Round ${s.round}/${s.rules.maxRounds}`;

  if (s.shake > 0) ctx.restore();
}

// ---------- Online mode ----------
let netState = null;
let sendInputTimer = 0;

function startOnlineShell(ranked) {
  mode = "online";
  running = true;
  online.inMatch = false;
  online.ranked = ranked;
  online.room = null;
  online.myId = profile?.id;

  const keys = {};
  window.onkeydown = (e) => { keys[e.key.toLowerCase()] = true; resumeAudio(); if (e.key==="Enter") keys["enter"]=true; };
  window.onkeyup = (e) => { keys[e.key.toLowerCase()] = false; if (e.key==="Enter") keys["enter"]=false; };
  function resumeAudio(){ try{ getAudio().resume(); }catch{} }

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
        shoot: !!keys["r"]
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

  setMatchMsg((online.ranked ? "랭크전" : "일반전") + ` 시작! 상대: ${online.opponentName} | 5히트=라운드승, 7라운드(4선승)`);
});

socket.on("round_over", (data) => {
  // 라운드 결과는 UI에 살짝만 표시
  const s = data?.score;
  if (s) setMatchMsg(`라운드 종료! (내전적 표시) | ${s.left}:${s.right} | 다음 라운드 준비...`);
});

socket.on("round_start", (data) => {
  setMatchMsg(`Round ${data.round} 시작! 스코어 ${data.score.left}:${data.score.right}`);
});

socket.on("state", (s) => {
  netState = s;
});

socket.on("match_over", (data) => {
  const win = data.winnerId === online.myId;

  // ★ 요청: 글로벌(온라인)일 때만 승/패 문구
  setMatchMsg(win ? "승리 하였습니다! 🎉" : "패배 하였습니다.. 😢");

  const my = data.profiles?.[online.myId];
  if (my) profile = my;
  leaderboard = data.leaderboard || leaderboard;

  updateTopBar();
  updateRankLockMsg();

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

  drawOwl(left.x, left.y, "left", left.hp, 5);
  drawOwl(right.x, right.y, "right", right.hp, 5);

  const myIsLeft = left.id === online.myId;
  const myHP = myIsLeft ? left.hp : right.hp;
  const opHP = myIsLeft ? right.hp : left.hp;

  hudLeft.textContent = `내 HP: ${myHP} | 스코어 ${s.score?.left ?? 0}:${s.score?.right ?? 0} | Round ${s.round ?? 1}/7`;
  hudRight.textContent = `${online.opponentName} HP: ${opHP}`;
  hudMid.textContent = online.ranked ? "온라인 랭크" : "온라인 일반";
}
