/**
 * The Workers colony: a far-view 2D cutaway drawn on a canvas. The camp is on the left, the spec's hall rises in
 * five phases in the centre, the quarry is on the right, finished halls stand as a skyline on the far ridge.
 * Agents are the workers; the running Delivery's spec is the hall. Ported from the approved prototype; all art is
 * canvas code.
 */
import { phaseOf, PHASE_NAMES, type HallEvent, type Kind } from "./workers";

type C = CanvasRenderingContext2D;

/** An agent as the colony needs it. */
export type Worker = {
  id: string;
  name: string;
  kind: Kind;
  roleLabel: string;
  group: string;
  hat: string;
  shirt: string;
  initials: string;
  /** Its agent runs a run now. */
  on: boolean;
  /** It has a Needs you item. */
  need: boolean;
  /** What a running agent says it's doing (its status line). */
  status: string;
  /** The ticket it builds, when it's the running Delivery's Dev. */
  ticket: { number: number; title: string } | null;
};

/** The hall: the running Delivery's spec. */
export type HallView = { key: string; title: string; spec: number; pr: number | null; done: number; total: number; pct: number };
export type Finished = { key: string; title: string; spec: number };

const S = { RESTING: "RESTING", DISPATCHING: "DISPATCHING", WORKING: "WORKING", HAULING: "HAULING", STANDBY: "STANDBY", INSPECTING: "INSPECTING", PLANNING: "PLANNING", RETURNING: "RETURNING_TO_CAMP" } as const;
type St = (typeof S)[keyof typeof S];
const REST_POSES = ["warm", "sleep", "sit"];
const OUT = "#1a1424", SKIN = "#f2c29b", PANTS = "#2a2236";

export type Sim = Worker & {
  n: number;
  x: number; y: number; state: St; phase: number; actT: number; dir: number; moving: boolean; prevS: number;
  pose: string; zT: number; dustT: number; carry: boolean; load: "stone" | "timber"; action: "dig" | "hammer";
  /** The ticket being inspected. */
  num: number | null;
  /** The ticket this haul delivers ("+1 #N"). */
  deliver: number | null;
  rush: boolean; rowCur: number; patrol: number; dest: number; labelTop?: number;
};
type Particle = { type: string; x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color?: string };
type Float = { x: number; y: number; text: string; color: string; life: number };

export type World = {
  stars: { x: number; y: number; r: number; tw: number }[];
  ore: { x: number; d: number; r: number; kind: string }[];
  pebbles: { x: number; d: number; r: number }[];
  trees: { x: number; h: number }[];
  agents: Sim[];
  /** The hall: `shown` eases toward `target` (percent done); `view` is null with no running Delivery. */
  hall: { view: HallView | null; shown: number; target: number; celebrate: number; celebrating: string | null; next: { view: HallView | null } | null };
  finished: Finished[];
  queue: number[];
  events: HallEvent[];
  particles: Particle[]; floats: Float[];
  t: number; sparkAcc: number; par: number; parTarget: number; speed: number; reduced: boolean;
  selected: string | null; hover: string | null;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function makeWorld(): World {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return {
    stars: Array.from({ length: 110 }, () => ({ x: rnd(), y: rnd() * 0.42, r: rnd() * 1.1 + 0.3, tw: rnd() * 6 })),
    ore: Array.from({ length: 30 }, () => { const k = rnd(); return { x: 0.64 + rnd() * 0.36, d: 0.2 + rnd() * 0.72, r: 3 + rnd() * 6, kind: k < 0.55 ? "gold" : k < 0.75 ? "gem" : "rock" }; }),
    pebbles: Array.from({ length: 60 }, () => ({ x: rnd(), d: 0.1 + rnd() * 0.85, r: 1.5 + rnd() * 4 })),
    trees: Array.from({ length: 26 }, () => ({ x: rnd(), h: 0.6 + rnd() * 0.6 })),
    agents: [],
    hall: { view: null, shown: 0, target: 0, celebrate: 0, celebrating: null, next: null },
    finished: [], queue: [], events: [], particles: [], floats: [], t: 0, sparkAcc: 0, par: 0.5, parTarget: 0.5, speed: 1, reduced: false, selected: null, hover: null,
  };
}

export type Geo = { W: number; H: number; s: number; base: number; campL: number; campR: number; fireX: number; signX: number; siteL: number; siteR: number; siteX: number; qL: number; qR: number };

export function geometry(W: number, H: number): Geo {
  const s = clamp(Math.min(W / 1050, H / 470), 0.5, 1.25);
  // a narrow screen gives the camp (and the crowd in it) more of the width, and the quarry less
  if (W < 600) return { W, H, s, base: H * 0.6, campL: W * 0.01, campR: W * 0.29, fireX: W * 0.14, signX: W * 0.3, siteL: W * 0.37, siteR: W * 0.62, siteX: W * 0.495, qL: W * 0.7, qR: W * 0.985 };
  return { W, H, s, base: H * 0.6, campL: W * 0.02, campR: W * 0.24, fireX: W * 0.12, signX: W * 0.27, siteL: W * 0.33, siteR: W * 0.58, siteX: W * 0.455, qL: W * 0.67, qR: W * 0.985 };
}
export function groundY(g: Geo, x: number): number {
  let y = g.base;
  const bump = (cx: number, wd: number, h: number) => { const t = (x - g.W * cx) / (g.W * wd); y -= g.H * h * Math.exp(-t * t); };
  bump(0.285, 0.035, 0.04); bump(0.625, 0.03, 0.035);
  if (x > g.qL && x < g.qR) { const u = (x - g.qL) / (g.qR - g.qL); y += g.H * 0.1 * Math.pow(Math.sin(u * Math.PI), 0.55); }
  return y;
}
const workX = (g: Geo, n: number) => g.qL + (0.12 + 0.76 * ((n * 0.37) % 1)) * (g.qR - g.qL);
const dropX = (g: Geo, n: number) => g.siteX + ((n % 5) - 2) * 12 * g.s;
/**
 * Camp spot n: agents sit on both sides of the fire about 15px apart, out to the site on the right; when a row is full the
 * next row stands behind it, higher and a little smaller, so a crowd never piles up on one spot.
 */
const ROW = 20;
function campSlot(g: Geo, n: number): { x: number; row: number } {
  const gap = 19 * g.s, left = Math.max(1, Math.floor((g.fireX - (g.campL + 8)) / gap)), right = Math.max(1, Math.floor((g.siteL - 14 * g.s - g.fireX) / gap));
  const both = 2 * Math.min(left, right), perRow = left + right;
  const row = Math.floor(n / perRow), m = n % perRow;
  const side = m < both ? (m % 2 === 0 ? -1 : 1) : left > right ? -1 : 1;
  const k = m < both ? Math.floor(m / 2) : Math.min(left, right) + (m - both);
  return { x: g.fireX + side * (gap * 0.9 + k * gap), row };
}
const postX = (g: Geo, a: Sim) => (a.kind === "qa" ? g.siteL + 6 * g.s : g.siteR - (a.kind === "security" ? 22 : 6) * g.s) + (a.n % 3) * 7 * g.s;
const patrolX = (g: Geo, k: number) => [g.siteL + 20 * g.s, g.siteX, g.siteR - 20 * g.s, g.siteX - 30 * g.s][k % 4];

/* ---------- data in ---------- */

/** Makes the colony's agents match `list`: new ones arrive (working ones already at work), gone ones leave, the rest keep their place with updated data. */
export function syncAgents(w: World, g: Geo, list: Worker[]) {
  const byId = new Map(w.agents.map((a) => [a.id, a]));
  w.agents = list.map((wk, n) => {
    const old = byId.get(wk.id);
    if (old) return Object.assign(old, wk, { n });
    const a = {
      ...wk, n, x: 0, y: 0, state: S.RESTING as St, phase: rand(0, 6), actT: rand(1, 4), dir: 1, moving: false, prevS: 0,
      pose: REST_POSES[n % 3], zT: rand(0, 1.4), dustT: 0, carry: false, load: n % 2 ? "stone" : "timber", action: n % 2 ? "hammer" : "dig",
      num: null, deliver: null, rush: false, rowCur: 0, patrol: 0, dest: 0,
    } as Sim;
    if (!wk.on) a.x = campSlot(g, n).x;
    else if (wk.kind === "dev") { a.state = S.WORKING; a.x = workX(g, n); }
    else if (wk.kind === "lead") { a.state = S.PLANNING; a.x = patrolX(g, 0); }
    else { a.state = S.STANDBY; a.x = postX(g, a); }
    a.rowCur = a.on ? 0 : campSlot(g, n).row;
    a.y = groundY(g, a.x) - a.rowCur * ROW * g.s;
    return a;
  });
  if (w.selected && w.selected !== "hall" && !w.selected.startsWith("hill:") && !list.some((a) => a.id === w.selected)) w.selected = null;
}

/** Keeps agents where they stood when the canvas is resized. */
export function rescale(w: World, g: Geo, ratio: number) {
  for (const a of w.agents) { a.x *= ratio; a.dest *= ratio; a.y = groundY(g, a.x) - a.rowCur * ROW * g.s; }
}

/** The hall to build: its progress eases toward `view.pct` (never to the full building until the spec merges). Null: an empty lot. */
export function setHall(w: World, view: HallView | null) {
  const h = w.hall;
  if (h.celebrate > 0) { h.next = { view }; return; }
  const switched = (h.view?.key ?? null) !== (view?.key ?? null);
  h.view = view;
  h.target = view ? Math.min(view.pct, 99.5) : 0;
  if (switched) h.shown = Math.min(h.shown, h.target);
}

/** The merged specs for the skyline, newest first; the one being celebrated joins it when the party ends. */
export function setFinished(w: World, merged: Finished[]) { w.finished = merged; }

/** A merge starts its party at once, so the hall isn't swapped for the next one first; the rest wait for the next step. */
export function pushEvent(w: World, e: HallEvent) {
  if (e.type === "merged") handle(w, e);
  else w.events.push(e);
}

/* ---------- simulation ---------- */

function moveTo(a: Sim, dest: number, v: number, dt: number): boolean {
  const d = dest - a.x;
  a.moving = true;
  if (Math.abs(d) <= v * dt) { a.x = dest; a.moving = false; return true; }
  a.dir = Math.sign(d); a.x += Math.sign(d) * v * dt; return false;
}
const emit = (w: World, p: Particle) => { if (w.particles.length < 450) w.particles.push(p); };
const float = (w: World, x: number, y: number, text: string, color: string) => w.floats.push({ x, y, text, color, life: 1.8 });

/** A Dev reached the site: with a ticket to deliver it shows "+1 #N"; otherwise it was only a haul. */
function deliver(w: World, g: Geo, a: Sim) {
  a.carry = false;
  for (let k = 0; k < 8; k++) emit(w, { type: "dust", x: a.x + rand(-6, 6), y: a.y - 3, vx: rand(-40, 40), vy: rand(-50, -10), life: 0.6, max: 0.6, size: rand(2, 3.5) * g.s, color: "#c9a377" });
  if (a.deliver !== null) { float(w, a.x, a.y - 60 * g.s, `+1 #${a.deliver}`, "#ffe066"); a.deliver = null; }
}

function handle(w: World, e: HallEvent) {
  if (e.type === "review") { if (w.queue.length < 8) w.queue.push(e.number); return; }
  if (e.type === "closed") {
    const devs = w.agents.filter((a) => a.kind === "dev" && a.on);
    const a = devs.find((d) => d.state !== S.HAULING) ?? devs[0];
    if (!a) return;
    a.state = S.HAULING; a.carry = true; a.rush = true; a.deliver = e.number; a.load = Math.random() < 0.5 ? "stone" : "timber";
    return;
  }
  // merged: the hall is complete, with a party
  const h = w.hall;
  if (h.celebrate > 0) return;
  h.celebrate = w.reduced ? 4 : 8; h.shown = 100; h.celebrating = e.key;
  w.floats.push({ x: 0, y: 0, text: `${e.title} complete!`, color: "#ffffff", life: 3 }); // placed at the hall by the step, which knows the geometry
}

export function step(w: World, g: Geo, dt: number) {
  const v = 90 * g.s * w.speed;
  w.t += dt;
  w.par += (w.parTarget - w.par) * Math.min(1, dt * 2);
  for (const e of w.events.splice(0)) handle(w, e);
  for (const f of w.floats) if (f.x === 0 && f.y === 0) { f.x = g.siteX; f.y = groundY(g, g.siteX) - 150 * g.s; }
  const h = w.hall;
  if (h.celebrate > 0) {
    h.celebrate -= dt;
    const top = groundY(g, g.siteX) - 150 * g.s;
    if (!w.reduced && Math.random() < dt * 60) emit(w, { type: "confetti", x: g.siteX + rand(-80, 80) * g.s, y: top + rand(-10, 10), vx: rand(-40, 40), vy: rand(-60, 0), life: 2.4, max: 2.4, size: rand(2, 4) * g.s, color: ["#ffe066", "#ff6b8a", "#6fd3ff", "#8dff7a", "#ffffff"][(Math.random() * 5) | 0] });
    if (h.celebrate <= 0) {
      h.celebrating = null;
      const next = h.next; h.next = null; h.shown = 0;
      setHall(w, next ? next.view : null);
    }
  } else h.shown += (h.target - h.shown) * Math.min(1, dt * 2);

  for (const a of w.agents) {
    const cx = campSlot(g, a.n).x, dev = a.kind === "dev";
    a.moving = false;
    if (!a.on && ![S.RESTING, S.RETURNING, S.HAULING].includes(a.state as never)) { a.state = S.RETURNING; a.deliver = null; }
    switch (a.state) {
      case S.RESTING:
        a.dir = Math.sign(g.fireX - a.x) || 1; a.phase += dt * 1.6;
        if (a.pose === "sleep") { a.zT -= dt; if (a.zT <= 0) { a.zT = 1.3; emit(w, { type: "z", x: a.x + 6 * g.s * a.dir, y: a.y - 30 * g.s, vx: 6, vy: -14, life: 2.4, max: 2.4, size: 9 * g.s }); } }
        if (a.on) { a.actT -= dt * w.speed; if (a.actT <= 0) a.state = dev ? S.DISPATCHING : a.kind === "lead" ? S.PLANNING : S.STANDBY; } // each leaves a moment after the others
        break;
      case S.DISPATCHING:
        a.phase += dt * 9 * w.speed;
        if (moveTo(a, workX(g, a.n), v, dt)) { a.state = S.WORKING; a.actT = rand(7, 12); a.dir = 1; }
        break;
      case S.WORKING: {
        a.phase += dt * (a.action === "hammer" ? 8 : 5) * w.speed;
        const sn = Math.sin(a.phase);
        if (a.prevS > 0 && sn <= 0) for (let k = 0; k < 5; k++) emit(w, { type: k < 2 ? "chip" : "dust", x: a.x + a.dir * 15 * g.s, y: a.y - 2, vx: rand(-30, 30) + a.dir * 20, vy: rand(-70, -25), life: rand(0.4, 0.8), max: 0.8, size: rand(1.5, 3) * g.s, color: k < 2 ? "#e9c46a" : "#c9a377" });
        a.prevS = sn; a.actT -= dt * w.speed;
        if (a.actT <= 0) { a.state = S.HAULING; a.carry = true; a.load = Math.random() < 0.5 ? "stone" : "timber"; }
        break;
      }
      case S.HAULING:
        a.phase += dt * (a.rush ? 10 : 6) * w.speed;
        if (moveTo(a, dropX(g, a.n), v * (a.rush ? 1.4 : 0.85), dt)) {
          deliver(w, g, a); a.rush = false;
          a.state = a.on ? S.DISPATCHING : S.RETURNING;
        }
        break;
      case S.STANDBY:
        a.phase += dt * 8 * w.speed;
        if (moveTo(a, postX(g, a), v * 0.8, dt) && w.queue.length) { a.num = w.queue.shift()!; a.state = S.INSPECTING; a.actT = 2.4; a.dest = g.siteX + rand(-50, 50) * g.s; }
        if (!a.moving) a.dir = Math.sign(g.siteX - a.x) || 1;
        break;
      case S.INSPECTING:
        a.phase += dt * 8 * w.speed;
        if (moveTo(a, a.dest, v * 0.8, dt)) {
          a.dir = Math.sign(g.siteX - a.x) || 1; a.actT -= dt * w.speed;
          if (a.actT <= 0) { float(w, a.x, a.y - 52 * g.s, `✓ ${a.kind === "qa" ? "QA" : a.kind === "security" ? "SEC" : "Review"} #${a.num}`, "#8dff7a"); a.state = S.STANDBY; }
        }
        break;
      case S.PLANNING:
        a.phase += dt * 7 * w.speed;
        if (moveTo(a, patrolX(g, a.patrol), v * 0.55, dt)) { a.actT -= dt * w.speed; if (a.actT <= 0) { a.patrol++; a.actT = rand(1.5, 3); } }
        break;
      case S.RETURNING:
        a.phase += dt * 8 * w.speed; a.carry = false;
        if (a.on) { a.state = dev ? S.DISPATCHING : a.kind === "lead" ? S.PLANNING : S.STANDBY; break; }
        if (moveTo(a, cx, v * 0.85, dt)) { a.state = S.RESTING; a.actT = rand(0, 5); a.pose = REST_POSES[Math.floor(Math.random() * 3)]; }
        break;
    }
    if (a.moving) { a.dustT -= dt * w.speed; if (a.dustT <= 0) { a.dustT = 0.22; emit(w, { type: "dust", x: a.x - a.dir * 4 * g.s, y: a.y - 1, vx: -a.dir * rand(5, 20), vy: rand(-18, -6), life: 0.5, max: 0.5, size: rand(1.5, 2.6) * g.s, color: "#b8936a" }); } }
    // at rest the agent stands in its camp row (higher and smaller toward the back); at work it is on the ground
    const target = a.state === S.RESTING || a.state === S.RETURNING ? campSlot(g, a.n).row : 0;
    a.rowCur += (target - a.rowCur) * Math.min(1, dt * 3);
    a.y = groundY(g, a.x) - a.rowCur * ROW * g.s;
  }

  w.sparkAcc += dt * 26;
  const fy = groundY(g, g.fireX);
  while (w.sparkAcc > 1) {
    w.sparkAcc -= 1;
    emit(w, Math.random() < 0.8
      ? { type: "spark", x: g.fireX + rand(-6, 6) * g.s, y: fy - 10 * g.s, vx: rand(-12, 12), vy: rand(-70, -35), life: rand(0.6, 1.4), max: 1.4, size: rand(1, 2.2) * g.s }
      : { type: "smoke", x: g.fireX + rand(-4, 4) * g.s, y: fy - 22 * g.s, vx: rand(4, 14), vy: rand(-22, -12), life: 3, max: 3, size: rand(5, 9) * g.s });
  }
  for (const p of w.particles) {
    p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.type === "chip" || p.type === "dust") p.vy += 160 * dt;
    if (p.type === "confetti") { p.vy += 40 * dt; p.vx *= 0.99; }
    if (p.type === "spark") p.vx += Math.sin(w.t * 6 + p.y * 0.05) * 10 * dt;
    if (p.type === "smoke") p.size += dt * 5;
  }
  w.particles = w.particles.filter((p) => p.life > 0);
  for (const f of w.floats) { f.life -= dt; f.y -= dt * 22; }
  w.floats = w.floats.filter((f) => f.life > 0);
}

/* ---------- drawing ---------- */


function rr(ctx: C, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function hills(ctx: C, g: Geo, yBase: number, amp: number, f: number, off: number, color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, g.H);
  for (let x = 0; x <= g.W + 8; x += 8) ctx.lineTo(x, yBase - amp * (0.6 * Math.sin(x * f + off) + 0.4 * Math.sin(x * f * 2.3 + off * 1.7)));
  ctx.lineTo(g.W, g.H); ctx.closePath(); ctx.fill();
}

function drawBackdrop(ctx: C, g: Geo, w: World) {
  const { W, H } = g;
  const sky = ctx.createLinearGradient(0, 0, 0, g.base);
  sky.addColorStop(0, "#151a36"); sky.addColorStop(0.5, "#3b3462"); sky.addColorStop(0.85, "#b8667a"); sky.addColorStop(1, "#f2a173");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  for (const s of w.stars) { ctx.globalAlpha = 0.35 + 0.35 * Math.sin(w.t * 1.5 + s.tw); ctx.fillStyle = "#fff6e6"; ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, 7); ctx.fill(); }
  ctx.globalAlpha = 1;
  const mx = W * 0.82, my = H * 0.15, mr = 16 * g.s + 6;
  const halo = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 4);
  halo.addColorStop(0, "rgba(255,236,200,0.35)"); halo.addColorStop(1, "rgba(255,236,200,0)");
  ctx.fillStyle = halo; ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
  ctx.fillStyle = "#ffeccb"; ctx.beginPath(); ctx.arc(mx, my, mr, 0, 7); ctx.fill();
  const p = w.par - 0.5;
  hills(ctx, g, g.base - H * 0.2, H * 0.05, 0.006, 1.3 + p * 0.3, "#4b3f70");
  drawSkyline(ctx, g, w, p);
  hills(ctx, g, g.base - H * 0.1, H * 0.045, 0.009, 4.1 + p * 0.7, "#352f57");
  ctx.fillStyle = "#262443";
  for (const t of w.trees) {
    const x = ((t.x * (W + 80) + p * 40) % (W + 80)) - 40, yb = g.base - H * 0.045 - H * 0.025 * Math.sin(x * 0.01), hh = 22 * g.s * t.h + 8;
    ctx.beginPath(); ctx.moveTo(x, yb - hh); ctx.lineTo(x - hh * 0.32, yb); ctx.lineTo(x + hh * 0.32, yb); ctx.closePath(); ctx.fill();
  }
  hills(ctx, g, g.base - H * 0.025, H * 0.018, 0.013, 2 + p * 1.1, "#2a2846");
}

// finished halls stand on the far ridge, a town that grows with every merged spec
function drawSkyline(ctx: C, g: Geo, w: World, p: number) {
  const s = g.s, list = w.finished.filter((f) => f.key !== w.hall.celebrating).slice(0, 6).reverse(), n = list.length;
  list.forEach((_, i) => {
    const x = g.W * (0.32 + 0.07 * i) + p * 18, y = g.base - g.H * 0.2 - g.H * 0.05 * (0.6 * Math.sin(x * 0.006 + 1.3 + p * 0.3)) + 2;
    const bw = 34 * s, bh = 22 * s;
    ctx.fillStyle = "#2f2752"; ctx.fillRect(x - bw / 2, y - bh, bw, bh + 6);
    ctx.beginPath(); ctx.moveTo(x - bw / 2 - 4 * s, y - bh); ctx.lineTo(x, y - bh - 14 * s); ctx.lineTo(x + bw / 2 + 4 * s, y - bh); ctx.closePath(); ctx.fill();
    ctx.fillRect(x + bw * 0.22, y - bh - 14 * s, 4 * s, 10 * s);
    ctx.fillStyle = `rgba(255,214,130,${0.75 + 0.2 * Math.sin(w.t * 2 + i)})`;
    for (const wx of [-0.3, 0, 0.3]) ctx.fillRect(x + wx * bw - 2.5 * s, y - bh + 7 * s, 5 * s, 5 * s);
    ctx.strokeStyle = "#2f2752"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y - bh - 14 * s); ctx.lineTo(x, y - bh - 24 * s); ctx.stroke();
    ctx.fillStyle = i === n - 1 ? "#ffd27a" : "#8f7fc4"; ctx.fillRect(x, y - bh - 24 * s, 7 * s, 4.5 * s);
  });
}

function surfacePath(ctx: C, g: Geo) { ctx.beginPath(); ctx.moveTo(0, g.H); for (let x = 0; x <= g.W + 4; x += 4) ctx.lineTo(x, groundY(g, x)); ctx.lineTo(g.W, g.H); ctx.closePath(); }

function drawGround(ctx: C, g: Geo, w: World) {
  const { W, H, s } = g;
  surfacePath(ctx, g); ctx.fillStyle = "#7a5534"; ctx.fill();
  ctx.save(); surfacePath(ctx, g); ctx.clip();
  ["#6a482c", "#5a3c26", "#4a3120", "#3a261a"].forEach((c, k) => {
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W + 6; x += 6) ctx.lineTo(x, groundY(g, x) + H * (0.06 + k * 0.08) + Math.sin(x * 0.012 + k * 2) * 5 * s + Math.sin(x * 0.041 + k) * 2);
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  });
  for (const pb of w.pebbles) { const x = pb.x * W, gy = groundY(g, x), y = gy + 10 + pb.d * (H - gy - 14); ctx.fillStyle = "rgba(20,12,8,0.28)"; ctx.beginPath(); ctx.ellipse(x, y, pb.r * s * 1.4, pb.r * s, 0, 0, 7); ctx.fill(); }
  for (const o of w.ore) {
    const x = o.x * W, gy = groundY(g, x), y = gy + 16 * s + o.d * (H - gy - 22 * s), r = o.r * s;
    if (o.kind === "gold") {
      ctx.fillStyle = "#b9851f"; ctx.beginPath(); ctx.ellipse(x, y + 1, r * 1.1, r * 0.85, 0.3, 0, 7); ctx.fill();
      ctx.fillStyle = "#f4c542"; ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.75, 0.3, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,250,210,${0.55 + 0.4 * Math.sin(w.t * 2 + o.x * 40)})`; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.25, r * 0.25, 0, 7); ctx.fill();
    } else if (o.kind === "gem") {
      ctx.fillStyle = "#58d6e8"; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.7, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.7, y); ctx.closePath(); ctx.fill();
    } else { ctx.fillStyle = "#6e6a78"; ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r * 0.9, 0, 0, 7); ctx.fill(); }
  }
  // the hall's footings go down into the earth
  const fx0 = g.siteX - 92 * s, fx1 = g.siteX + 92 * s, fy = groundY(g, g.siteX);
  ctx.fillStyle = "#5e5a6b"; ctx.fillRect(fx0, fy, fx1 - fx0, 10 * s);
  ctx.fillStyle = "#4b4858"; for (let x = fx0; x < fx1; x += 14 * s) ctx.fillRect(x, fy + 4 * s, 1.5, 6 * s);
  ctx.restore();
  const edge = (x0: number, x1: number, color: string, width: number, dy: number) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.beginPath(); for (let x = x0; x <= x1; x += 4) { const y = groundY(g, x) + dy; x === x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); };
  edge(0, g.signX, "#6f9150", 5 * s, 1);
  edge(g.W * 0.26, g.qL, "#c79b62", 7 * s, 3);
  edge(g.qL - 6, g.qR + 4, "#ddb877", 5 * s, 2);
  edge(g.qR, g.W, "#6f9150", 5 * s, 1);
}

function signpost(ctx: C, g: Geo, x: number, text: string, flip: boolean) {
  const s = g.s, y = groundY(g, x);
  ctx.fillStyle = "#5a3d24"; ctx.fillRect(x - 2 * s, y - 34 * s, 4 * s, 34 * s);
  ctx.font = `600 ${Math.round(9 * s + 2)}px "Chakra Petch", sans-serif`;
  const tw = ctx.measureText(text).width + 14 * s, bx = flip ? x - tw + 4 * s : x - 4 * s, by = y - 34 * s;
  ctx.fillStyle = "#c08a52"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; ctx.beginPath();
  if (flip) { ctx.moveTo(bx - 7 * s, by + 7 * s); ctx.lineTo(bx, by); ctx.lineTo(bx + tw, by); ctx.lineTo(bx + tw, by + 14 * s); ctx.lineTo(bx, by + 14 * s); }
  else { ctx.moveTo(bx, by); ctx.lineTo(bx + tw, by); ctx.lineTo(bx + tw + 7 * s, by + 7 * s); ctx.lineTo(bx + tw, by + 14 * s); ctx.lineTo(bx, by + 14 * s); }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#2a1b10"; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillText(text, bx + 7 * s, by + 7.5 * s);
}
function lantern(ctx: C, g: Geo, x: number, y: number, w: World) {
  const s = g.s;
  ctx.fillStyle = "#3a2a1c"; ctx.fillRect(x - 1.2 * s, y, 2.4 * s, 22 * s);
  ctx.fillStyle = "#2b2230"; rr(ctx, x - 4 * s, y - 9 * s, 8 * s, 10 * s, 2 * s); ctx.fill();
  ctx.fillStyle = `rgba(255,214,120,${0.85 + 0.15 * Math.sin(w.t * 7 + x)})`; rr(ctx, x - 2.6 * s, y - 7.5 * s, 5.2 * s, 7 * s, 1.5 * s); ctx.fill();
}

function drawCamp(ctx: C, g: Geo, w: World) {
  const s = g.s;
  const tent = (x: number, color: string, dark: string) => {
    const y = groundY(g, x), hw = 26 * s, h = 30 * s;
    ctx.fillStyle = color; ctx.strokeStyle = OUT; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + hw, y); ctx.lineTo(x - hw, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(x, y - h + 6 * s); ctx.lineTo(x + 8 * s, y); ctx.lineTo(x - 8 * s, y); ctx.closePath(); ctx.fill();
  };
  tent(g.campL + 28 * s, "#c8684a", "#5a2a20");
  tent(g.campR - 18 * s, "#4f7fae", "#1f3550");
  lantern(ctx, g, g.campL + 62 * s, groundY(g, g.campL + 62 * s) - 22 * s, w);
  const fy = groundY(g, g.fireX);
  for (const side of [-1, 1]) { const bx = g.fireX + side * 30 * s; ctx.fillStyle = "#6b4527"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; rr(ctx, bx - 12 * s, fy - 6 * s, 24 * s, 6 * s, 3 * s); ctx.fill(); ctx.stroke(); }
  ctx.fillStyle = "#5d5866"; for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.ellipse(g.fireX + k * 5 * s, fy - 1.5 * s, 3.2 * s, 2.4 * s, 0, 0, 7); ctx.fill(); }
  const fl = (wd: number, ht: number, c: string, ph: number) => {
    const f = 1 + 0.12 * Math.sin(w.t * 13 + ph) + 0.08 * Math.sin(w.t * 21 + ph * 2);
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(g.fireX - wd * s, fy - 5 * s);
    ctx.quadraticCurveTo(g.fireX - wd * 0.9 * s, fy - ht * 0.6 * s * f, g.fireX + Math.sin(w.t * 5 + ph) * 2 * s, fy - ht * s * f);
    ctx.quadraticCurveTo(g.fireX + wd * 0.9 * s, fy - ht * 0.6 * s * f, g.fireX + wd * s, fy - 5 * s); ctx.closePath(); ctx.fill();
  };
  fl(10, 30, "#ff5a3a", 0); fl(7.5, 23, "#ff9a3c", 1.3); fl(4.5, 15, "#ffe07a", 2.1);
  signpost(ctx, g, g.signX, "CAMP", true);
  signpost(ctx, g, g.qL - g.W * 0.03, "QUARRY", false);
}

function drawQuarry(ctx: C, g: Geo, w: World) {
  const s = g.s, qw = g.qR - g.qL;
  for (const [fx, r] of [[0.05, 22], [0.95, 26]]) {
    const x = g.qL + fx * qw, y = groundY(g, x) + 2;
    ctx.fillStyle = "#d9b273"; ctx.beginPath(); ctx.ellipse(x, y, r * s, r * 0.55 * s, 0, Math.PI, 0); ctx.fill();
  }
  const x0 = g.qL + qw * 0.6, x1 = g.qR - 6 * s, top = g.base - 50 * s;
  ctx.strokeStyle = "#8a5b33"; ctx.lineWidth = 3 * s; ctx.lineCap = "round";
  for (let k = 0; k <= 3; k++) { const x = x0 + (x1 - x0) * k / 3; ctx.beginPath(); ctx.moveTo(x, groundY(g, x)); ctx.lineTo(x, top); ctx.stroke(); }
  ctx.lineWidth = 2.4 * s; ctx.beginPath(); ctx.moveTo(x0 - 4 * s, top); ctx.lineTo(x1 + 4 * s, top); ctx.stroke();
  lantern(ctx, g, (x0 + x1) / 2, top - 22 * s, w);
}

function crate(ctx: C, x: number, y: number, sz: number) {
  ctx.fillStyle = "#b07a45"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5;
  ctx.fillRect(x - sz / 2, y - sz, sz, sz); ctx.strokeRect(x - sz / 2, y - sz, sz, sz);
  ctx.strokeStyle = "#6d4523"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x - sz / 2, y - sz); ctx.lineTo(x + sz / 2, y); ctx.moveTo(x + sz / 2, y - sz); ctx.lineTo(x - sz / 2, y); ctx.stroke();
}

// the spec's hall, side view, rising through five phases
function drawHall(ctx: C, g: Geo, w: World) {
  const s = g.s, done = w.hall.shown, ph = phaseOf(done), base = groundY(g, g.siteX);
  const hw = 88 * s, x0 = g.siteX - hw, x1 = g.siteX + hw;
  const q = (lo: number, hi: number) => clamp((done - lo) / (hi - lo), 0, 1);
  const stoneH = 24 * s, wallH = 66 * s, roofH = 52 * s;
  const scaffold = () => {
    ctx.strokeStyle = "#a8774a"; ctx.lineWidth = 3 * s; ctx.lineCap = "round";
    for (const x of [x0 - 10 * s, x0 - 22 * s, x1 + 10 * s, x1 + 22 * s]) { ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - (stoneH + wallH + 10 * s)); ctx.stroke(); }
    ctx.lineWidth = 2.4 * s;
    for (let k = 1; k <= 3; k++) { const y = base - k * 28 * s; ctx.beginPath(); ctx.moveTo(x0 - 26 * s, y); ctx.lineTo(x0 - 6 * s, y); ctx.moveTo(x1 + 6 * s, y); ctx.lineTo(x1 + 26 * s, y); ctx.stroke(); }
    ctx.strokeStyle = "rgba(168,119,74,0.6)"; ctx.lineWidth = 1.4 * s;
    ctx.beginPath(); ctx.moveTo(x0 - 22 * s, base); ctx.lineTo(x0 - 10 * s, base - 28 * s); ctx.moveTo(x1 + 22 * s, base); ctx.lineTo(x1 + 10 * s, base - 28 * s); ctx.stroke();
  };
  // foundation: stakes, string line, blueprint table
  ctx.fillStyle = "#6b4a2c"; ctx.fillRect(x0 - 4 * s, base - 3 * s, hw * 2 + 8 * s, 5 * s);
  if (ph === 1) {
    for (const x of [x0, x0 + hw * 0.66, x1 - hw * 0.66, x1]) { ctx.fillStyle = "#d1a46b"; ctx.fillRect(x - 1.5 * s, base - 14 * s, 3 * s, 14 * s); }
    ctx.strokeStyle = "#f3efe2"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, base - 11 * s); ctx.lineTo(x1, base - 11 * s); ctx.stroke();
    const n = Math.floor(q(0, 25) * 12);
    for (let k = 0; k < n; k++) { ctx.fillStyle = k % 2 ? "#8d8a97" : "#a9a6b3"; ctx.fillRect(x0 + k * (hw * 2 / 12), base - 6 * s, hw * 2 / 12 - 2, 5 * s); }
    ctx.fillStyle = "#6b4527"; ctx.fillRect(g.siteX - 14 * s, base - 14 * s, 3 * s, 14 * s); ctx.fillRect(g.siteX + 11 * s, base - 14 * s, 3 * s, 14 * s);
    ctx.fillStyle = "#3d6fb3"; ctx.fillRect(g.siteX - 18 * s, base - 18 * s, 36 * s, 5 * s);
    ctx.fillStyle = "#cfe3ff"; ctx.fillRect(g.siteX - 14 * s, base - 17 * s, 28 * s, 1); ctx.fillRect(g.siteX - 4 * s, base - 18 * s, 1, 5 * s);
    return;
  }
  // stone base
  const sh = ph === 2 ? Math.max(5 * s, q(25, 50) * stoneH) : stoneH;
  for (let y = 0, r = 0; y < sh; y += 7 * s, r++) for (let x = x0 + (r % 2 ? 9 * s : 0); x < x1; x += 18 * s) {
    const bw = Math.min(16 * s, x1 - x);
    ctx.fillStyle = (Math.round(x / s) + r) % 3 ? "#9a98a6" : "#86849a"; ctx.fillRect(x, base - y - 7 * s, bw, 6 * s);
    ctx.fillStyle = "#b9b6c4"; ctx.fillRect(x, base - y - 7 * s, bw, 1.5 * s);
  }
  if (ph === 2) { scaffold(); crate(ctx, x1 + 40 * s, base, 12 * s); crate(ctx, x1 + 53 * s, base, 12 * s); return; }
  const wb = base - stoneH, wt = wb - wallH;
  // timber frame and planks
  const fill = ph === 3 ? q(50, 75) : 1, rows = Math.floor(fill * (wallH / (7 * s)));
  for (let r = 0; r < rows; r++) { ctx.fillStyle = r % 2 ? "#b07a45" : "#a06a3a"; ctx.fillRect(x0 + 3 * s, wb - (r + 1) * 7 * s, hw * 2 - 6 * s, 7 * s); ctx.fillStyle = "#c99060"; ctx.fillRect(x0 + 3 * s, wb - (r + 1) * 7 * s, hw * 2 - 6 * s, 1.2 * s); }
  ctx.fillStyle = "#5e3d22";
  for (let k = 0; k <= 5; k++) ctx.fillRect(x0 + k * (hw * 2 - 5 * s) / 5, wt, 5 * s, wallH);
  ctx.fillRect(x0, wt, hw * 2, 5 * s); ctx.fillRect(x0, wt + wallH * 0.48, hw * 2, 3.5 * s);
  ctx.strokeStyle = "#5e3d22"; ctx.lineWidth = 3 * s; ctx.beginPath(); ctx.moveTo(x0 + 2 * s, wb); ctx.lineTo(x0 + (hw * 2) / 5, wt + wallH * 0.5); ctx.moveTo(x1 - 2 * s, wb); ctx.lineTo(x1 - (hw * 2) / 5, wt + wallH * 0.5); ctx.stroke();
  if (ph === 3) {
    scaffold();
    ctx.strokeStyle = "#c99a62"; ctx.lineWidth = 2 * s; const lx = x1 + 34 * s;
    ctx.beginPath(); ctx.moveTo(lx, base); ctx.lineTo(lx - 8 * s, wt); ctx.moveTo(lx + 8 * s, base); ctx.lineTo(lx, wt); ctx.stroke();
    for (let k = 1; k < 9; k++) { const y = base - k * (base - wt) / 9, off = -8 * s * k / 9; ctx.beginPath(); ctx.moveTo(lx + off, y); ctx.lineTo(lx + off + 8 * s, y); ctx.stroke(); }
    return;
  }
  // windows and door
  const lit = ph === 5;
  for (const k of [-0.68, -0.34, 0.34, 0.68]) {
    const wx = g.siteX + k * hw, wy = wt + 12 * s;
    ctx.fillStyle = "#3a2414"; ctx.fillRect(wx - 7 * s, wy - 1 * s, 14 * s, 16 * s);
    ctx.fillStyle = lit ? `rgba(255,214,122,${0.9 + 0.1 * Math.sin(w.t * 3 + k)})` : "#5f86a8"; ctx.fillRect(wx - 5.5 * s, wy, 11 * s, 14 * s);
    ctx.fillStyle = "#3a2414"; ctx.fillRect(wx - 0.6 * s, wy, 1.2 * s, 14 * s); ctx.fillRect(wx - 5.5 * s, wy + 6.5 * s, 11 * s, 1.2 * s);
  }
  ctx.fillStyle = "#3a2414"; rr(ctx, g.siteX - 11 * s, wb - 30 * s, 22 * s, 30 * s, 9 * s); ctx.fill();
  ctx.fillStyle = lit ? "#ffb85a" : "#7a4a24"; rr(ctx, g.siteX - 9 * s, wb - 28 * s, 18 * s, 28 * s, 8 * s); ctx.fill();
  // roof, tile rows climbing from the eaves
  const built = ph === 4 ? Math.max(1, Math.round(q(75, 100) * 8)) : 8;
  for (let r = 0; r < built; r++) {
    const y = wt - (r + 1) * (roofH / 8), inset = (r / 8) * (hw + 12 * s);
    ctx.fillStyle = r % 2 ? "#c4583a" : "#d36a45"; ctx.fillRect(x0 - 12 * s + inset, y, (hw + 12 * s - inset) * 2, roofH / 8 + 0.5);
    ctx.fillStyle = "#a3412b"; for (let x = x0 - 10 * s + inset + (r % 2) * 5 * s; x < x1 + 12 * s - inset; x += 10 * s) ctx.fillRect(x, y, 1.2 * s, roofH / 8);
  }
  if (ph === 4) { scaffold(); return; }
  // complete: chimney with smoke, banner, sign
  ctx.fillStyle = "#86849a"; ctx.fillRect(x1 - 36 * s, wt - roofH * 0.9, 12 * s, roofH * 0.6);
  if (Math.random() < 0.08) emit(w, { type: "smoke", x: x1 - 30 * s, y: wt - roofH * 0.95, vx: rand(4, 12), vy: rand(-22, -12), life: 3, max: 3, size: rand(4, 7) * s });
  const py = wt - roofH - 2 * s;
  ctx.fillStyle = "#3a2414"; ctx.fillRect(g.siteX - 1 * s, py - 30 * s, 2.4 * s, 30 * s);
  ctx.fillStyle = "#ffd27a"; ctx.beginPath(); ctx.moveTo(g.siteX + 1.4 * s, py - 30 * s);
  for (let k = 0; k <= 6; k++) ctx.lineTo(g.siteX + 1.4 * s + k * 4 * s, py - 30 * s + Math.sin(w.t * 5 + k) * 1.5 * s);
  ctx.lineTo(g.siteX + 25 * s, py - 18 * s); ctx.lineTo(g.siteX + 1.4 * s, py - 18 * s); ctx.closePath(); ctx.fill();
}

function drawCarry(ctx: C, kind: string | null, x: number, y: number, s: number) {
  if (kind === "stone") {
    ctx.fillStyle = "#8d8a97"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; rr(ctx, x - 7 * s, y - 5 * s, 14 * s, 10 * s, 3 * s); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#b9b6c4"; ctx.fillRect(x - 6 * s, y - 4 * s, 12 * s, 2 * s);
  } else {
    for (let k = 0; k < 3; k++) { ctx.fillStyle = k % 2 ? "#a06a3a" : "#b07a45"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; rr(ctx, x - 10 * s, y - 5 * s + k * 3.4 * s, 20 * s, 3.4 * s, 1.5 * s); ctx.fill(); ctx.stroke(); }
  }
}

function drawAgent(ctx: C, a: Sim, g: Geo, selected: boolean, hovered: boolean, w: World) {
  const s = g.s, sit = a.state === S.RESTING;
  let legF = 0, legB = 0, armF = 0.3, armB = -0.2, sq = 1, bob = 0, slump = 0, tool: string | null = null, prop: string | null = null;
  if (a.moving) { const p = a.phase, sw = Math.sin(p); legF = sw * 0.65; legB = -legF; armF = -sw * 0.7; armB = sw * 0.7; bob = -Math.abs(Math.cos(p)) * (a.state === S.HAULING ? 1.4 : 2.4); sq = 1 + 0.05 * Math.cos(2 * p); }
  if (a.state === S.HAULING) armF = armB = 2.9;
  if (a.state === S.WORKING) { const sn = Math.sin(a.phase); tool = a.action === "hammer" ? "hammer" : "pick"; armF = (tool === "pick" ? 1.55 + 1.05 * sn : 1.25 + 0.95 * sn); armB = tool === "pick" ? armF - 0.25 : 0.2; sq = 1 - 0.07 * Math.max(0, -sn); }
  if ((a.state === S.STANDBY || a.state === S.INSPECTING) && !a.moving) { armF = 1.25; prop = "clipboard"; if (a.state === S.INSPECTING) armB = 1.1 + 0.15 * Math.sin(w.t * 9); }
  if (a.state === S.PLANNING) { armF = 1.35; armB = 1.15; prop = "blueprint"; }
  if (a.need) { armF = 2.85; prop = "sign"; }
  if (sit) { legF = legB = 1.45; if (a.pose === "sleep") { slump = 1; armF = armB = 0.35; } else if (a.pose === "warm") { armF = 1.45 + 0.06 * Math.sin(a.phase * 2); armB = 1.3; } else { armF = 0.55; armB = 0.25; } }

  ctx.save(); ctx.translate(a.x, a.y);
  ctx.fillStyle = "rgba(10,6,12,0.35)"; ctx.beginPath(); ctx.ellipse(0, 0, 10 * s, 2.6 * s, 0, 0, 7); ctx.fill();
  if (selected || hovered) { ctx.strokeStyle = selected ? "#ffd84a" : "rgba(255,255,255,0.5)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(0, 0, 14 * s, 4 * s, 0, 0, 7); ctx.stroke(); }
  const sc = Math.max(0.6, 1 - 0.07 * a.rowCur);
  ctx.scale(a.dir * s * sc, s * sc); ctx.translate(0, bob); ctx.scale(1 / Math.sqrt(sq), sq);
  const hipY = sit ? -5 : -11, legL = 11, shoulder = { x: 1 + slump * 2, y: hipY - 11 + slump * 2 }, head = { x: 1.5 + slump * 5, y: hipY - 19.5 + slump * 4 };
  const limb = (ox: number, oy: number, ang: number, len: number, color: string, wd: number) => {
    const ex = ox + Math.sin(ang) * len, ey = oy + Math.cos(ang) * len;
    ctx.strokeStyle = OUT; ctx.lineWidth = wd + 2.2; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke(); return { x: ex, y: ey };
  };
  const hand = (p: { x: number; y: number }) => { ctx.fillStyle = SKIN; ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, 7); ctx.fill(); ctx.stroke(); };
  const hb = limb(shoulder.x - 1, shoulder.y, armB, 9, a.shirt, 3.4); hand(hb);
  limb(-1.5, hipY, legB, legL, PANTS, 3.8);
  ctx.fillStyle = a.shirt; ctx.strokeStyle = OUT; ctx.lineWidth = 2; rr(ctx, -7, hipY - 13 + slump * 2, 15, 15 - slump * 2, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = a.hat; ctx.globalAlpha = 0.85; ctx.fillRect(-5.5, hipY - 1.5, 12, 2.2); ctx.globalAlpha = 1;
  limb(2, hipY, legF, legL, PANTS, 3.8);
  for (const [ang, ox] of [[legB, -1.5], [legF, 2]]) { ctx.fillStyle = "#3b2a22"; ctx.beginPath(); ctx.ellipse(ox + Math.sin(ang) * legL + 1.5, hipY + Math.cos(ang) * legL, 3.4, 2.2, 0, 0, 7); ctx.fill(); }
  ctx.fillStyle = SKIN; ctx.strokeStyle = OUT; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(head.x, head.y, 7.5, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(255,120,110,0.35)"; ctx.beginPath(); ctx.arc(head.x + 3.5, head.y + 3, 1.8, 0, 7); ctx.fill();
  if (sit && a.pose === "sleep") { ctx.strokeStyle = OUT; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(head.x + 2, head.y + 0.5); ctx.lineTo(head.x + 5, head.y + 0.5); ctx.stroke(); }
  else { ctx.fillStyle = OUT; ctx.beginPath(); ctx.ellipse(head.x + 3.6, head.y - 0.3, 1.2, 1.7, 0, 0, 7); ctx.fill(); }
  ctx.fillStyle = a.hat; ctx.strokeStyle = OUT; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(head.x - 0.5, head.y - 2.5, 8, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
  rr(ctx, head.x - 9, head.y - 3.5, 20, 3.2, 1.5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.ellipse(head.x - 3, head.y - 7.5, 2.6, 1.3, -0.4, 0, 7); ctx.fill();
  const lampOn = a.state === S.WORKING || a.state === S.HAULING;
  ctx.fillStyle = lampOn ? "#fff1a8" : "#8f8a7a"; ctx.beginPath(); ctx.arc(head.x + 6.5, head.y - 5, 1.9, 0, 7); ctx.fill();
  const hf = limb(shoulder.x + 1, shoulder.y, armF, 9, a.shirt, 3.4);
  if (tool) {
    const dx = Math.sin(armF), dy = Math.cos(armF), ex = hf.x + dx * (tool === "pick" ? 13 : 9), ey = hf.y + dy * (tool === "pick" ? 13 : 9);
    ctx.strokeStyle = "#7a4e2a"; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(hf.x - dx * 2, hf.y - dy * 2); ctx.lineTo(ex, ey); ctx.stroke();
    const px = -dy, py = dx;
    if (tool === "pick") { ctx.strokeStyle = "#b9bccb"; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(ex - px * 6 - dx * 2, ey - py * 6 - dy * 2); ctx.quadraticCurveTo(ex + dx * 2, ey + dy * 2, ex + px * 6 - dx * 2, ey + py * 6 - dy * 2); ctx.stroke(); }
    else { ctx.save(); ctx.translate(ex, ey); ctx.rotate(-armF); ctx.fillStyle = "#8d90a3"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.fillRect(-4.5, -2.5, 9, 5); ctx.strokeRect(-4.5, -2.5, 9, 5); ctx.restore(); }
  }
  if (prop === "clipboard") { ctx.fillStyle = "#a8774a"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.fillRect(hf.x - 1, hf.y - 9, 8, 10); ctx.strokeRect(hf.x - 1, hf.y - 9, 8, 10); ctx.fillStyle = "#f3efe2"; ctx.fillRect(hf.x + 0.5, hf.y - 7.5, 5, 7); ctx.fillStyle = "#7a7a8a"; for (let k = 0; k < 3; k++) ctx.fillRect(hf.x + 1.2, hf.y - 6 + k * 2, 3.6, 0.8); }
  if (prop === "blueprint") { ctx.fillStyle = "#3d6fb3"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.2; ctx.fillRect(hf.x - 4, hf.y - 7, 13, 9); ctx.strokeRect(hf.x - 4, hf.y - 7, 13, 9); ctx.strokeStyle = "#cfe3ff"; ctx.lineWidth = 0.8; ctx.strokeRect(hf.x - 2, hf.y - 5, 6, 5); ctx.beginPath(); ctx.moveTo(hf.x + 5, hf.y - 5); ctx.lineTo(hf.x + 7, hf.y - 1); ctx.stroke(); }
  if (prop === "sign") { const b = Math.sin(w.t * 6) * 1; ctx.strokeStyle = "#6b4423"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(hf.x, hf.y); ctx.lineTo(hf.x, hf.y - 12); ctx.stroke(); ctx.fillStyle = "#ffd84a"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; rr(ctx, hf.x - 7, hf.y - 26 + b, 14, 14, 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#c4362c"; ctx.fillRect(hf.x - 1.2, hf.y - 23 + b, 2.4, 6); ctx.fillRect(hf.x - 1.2, hf.y - 15.5 + b, 2.4, 2); }
  hand(hf);
  if (a.carry) drawCarry(ctx, a.load, head.x - 1, head.y - 16, 1);
  ctx.restore();
}

function drawParticles(ctx: C, w: World) {
  for (const p of w.particles) {
    const k = clamp(p.life / p.max, 0, 1);
    if (p.type === "spark") continue;
    if (p.type === "z") { ctx.globalAlpha = Math.min(1, k * 1.6); ctx.fillStyle = "#dfe8ff"; ctx.font = `700 ${Math.round(p.size + (1 - k) * 5)}px "Chakra Petch", sans-serif`; ctx.textAlign = "center"; ctx.fillText("z", p.x, p.y); }
    else if (p.type === "smoke") { ctx.globalAlpha = 0.18 * k; ctx.fillStyle = "#c9c2d6"; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill(); }
    else { ctx.globalAlpha = k; ctx.fillStyle = p.color ?? "#fff"; ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size * (p.type === "confetti" ? 0.6 : 1)); }
  }
  ctx.globalAlpha = 1;
}

function drawLight(ctx: C, g: Geo, w: World) {
  const s = g.s;
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const glow = (x: number, y: number, r: number, rgb: string, a: number) => { const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`); ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
  const fy = groundY(g, g.fireX), fl = 1 + 0.08 * Math.sin(w.t * 11) + 0.05 * Math.sin(w.t * 23);
  glow(g.fireX, fy - 12 * s, 130 * s * fl, "255,140,60", 0.32); glow(g.fireX, fy - 12 * s, 40 * s * fl, "255,200,110", 0.35);
  glow(g.campL + 62 * s, groundY(g, g.campL + 62 * s) - 26 * s, 34 * s, "255,210,120", 0.3);
  glow((g.qL + g.qR) / 2 + (g.qR - g.qL) * 0.3, g.base - 50 * s - 26 * s, 34 * s, "255,210,120", 0.3);
  if (phaseOf(w.hall.shown) === 5) glow(g.siteX, groundY(g, g.siteX) - 60 * s, 140 * s, "255,200,110", 0.25);
  for (const a of w.agents) if (a.state === S.WORKING || a.state === S.HAULING) glow(a.x + a.dir * 9 * s, a.y - 34 * s, 22 * s, "255,240,170", 0.22);
  for (const p of w.particles) if (p.type === "spark") { const k = clamp(p.life / p.max, 0, 1); ctx.fillStyle = `rgba(255,${(150 + 90 * k) | 0},80,${k})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill(); }
  ctx.restore();
  const v = ctx.createRadialGradient(g.W / 2, g.H * 0.55, Math.min(g.W, g.H) * 0.35, g.W / 2, g.H * 0.55, Math.max(g.W, g.H) * 0.8);
  v.addColorStop(0, "rgba(8,6,16,0)"); v.addColorStop(1, "rgba(8,6,16,0.5)"); ctx.fillStyle = v; ctx.fillRect(0, 0, g.W, g.H);
}

function wrap(ctx: C, text: string, max: number) {
  const words = text.split(" "), lines: string[] = []; let line = "";
  for (const wd of words) { const t = line ? line + " " + wd : wd; if (ctx.measureText(t).width > max && line) { lines.push(line); line = wd; } else line = t; }
  if (line) lines.push(line); return lines;
}

function bubble(ctx: C, g: Geo, ax: number, ay: number, title: string, sub: string, body: string, accent: string) {
  ctx.font = `500 ${Math.round(9 * g.s + 3)}px "JetBrains Mono", ui-monospace, monospace`;
  const lines = wrap(ctx, body, Math.min(220, g.W * 0.45));
  const lh = 9 * g.s + 6, bw = Math.max(...lines.map((l) => ctx.measureText(l).width), 120) + 20, bh = (lines.length + 2) * lh + 14;
  const bx = clamp(ax - bw / 2, 6, g.W - bw - 6), by = Math.max(6, ay - bh - 10);
  ctx.fillStyle = "#fbf6ec"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; rr(ctx, bx, by, bw, bh, 9); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax - 6, by + bh - 0.5); ctx.lineTo(ax, by + bh + 7); ctx.lineTo(ax + 6, by + bh - 0.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(ax - 6, by + bh); ctx.lineTo(ax, by + bh + 7); ctx.lineTo(ax + 6, by + bh); ctx.stroke();
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#231a2b"; ctx.font = `700 ${Math.round(9 * g.s + 4)}px "Chakra Petch", sans-serif`; ctx.fillText(title, bx + 10, by + 7 + lh / 2);
  ctx.fillStyle = accent; ctx.font = `700 ${Math.round(7 * g.s + 3)}px "Chakra Petch", sans-serif`; ctx.fillText(sub, bx + 10, by + 7 + lh * 1.5);
  ctx.fillStyle = "#231a2b"; ctx.font = `500 ${Math.round(9 * g.s + 3)}px "JetBrains Mono", ui-monospace, monospace`;
  lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 7 + lh * (2.5 + i)));
}

/** What an agent is doing, from real data: the ticket or Delivery it's on. */
export function taskLine(a: Sim, w: World): string {
  const h = w.hall.view;
  const spec = h ? `spec #${h.spec}: ${h.title}` : "";
  switch (a.state) {
    case S.RESTING: return a.need ? "Needs your answer" : a.pose === "sleep" ? "Asleep by the fire" : a.pose === "warm" ? "Warming up by the fire" : "On break at camp";
    case S.DISPATCHING: return "Walking to the quarry for the next ticket";
    case S.WORKING: case S.HAULING:
      return a.ticket ? `Building #${a.ticket.number}: ${a.ticket.title}` : h ? `${a.state === S.WORKING ? "Quarrying for" : "Hauling to"} ${h.title}` : a.status || "Working";
    case S.STANDBY: return "Waiting at the site for work to check";
    case S.INSPECTING: return `${a.kind === "qa" ? "Testing" : a.kind === "security" ? "Security-checking" : "Reviewing"} ticket #${a.num}`;
    case S.PLANNING: return h ? `Planning ${spec}` : "Planning";
    case S.RETURNING: return "Shift over, walking back to camp";
    default: return a.status || "";
  }
}
export const stateLabel = (s: string) => s.replace(/_/g, " ").toLowerCase();

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Where finished hall i of the skyline stands. */
function skylineSpot(g: Geo, w: World, i: number): { x: number; y: number } {
  const p = w.par - 0.5, x = g.W * (0.32 + 0.07 * i) + p * 18;
  return { x, y: g.base - g.H * 0.2 - g.H * 0.05 * (0.6 * Math.sin(x * 0.006 + 1.3 + p * 0.3)) + 2 };
}
const skyline = (w: World) => w.finished.filter((f) => f.key !== w.hall.celebrating).slice(0, 6).reverse();

function drawLabels(ctx: C, g: Geo, w: World) {
  const s = g.s, showAll = g.W >= 720 && w.agents.length <= 12;
  ctx.font = `600 ${Math.round(8.5 * s + 2.5)}px "Chakra Petch", sans-serif`;
  // stack labels that would overlap so every name stays readable
  const placed: { x: number; w: number; top: number }[] = [];
  const order = [...w.agents].sort((p, q) => p.x - q.x);
  for (const a of order) {
    const on = w.selected === a.id || w.hover === a.id;
    if (!showAll && !on) continue;
    const text = a.initials ? `${a.name} · ${a.initials}` : a.name;
    const tw = ctx.measureText(text).width + 14;
    let top = a.y - (a.carry ? 60 : a.need ? 70 : a.state === S.RESTING ? 40 : 46) * s;
    for (let tries = 0; tries < 6; tries++) {
      const hit = placed.find((p) => Math.abs(p.x - a.x) < (p.w + tw) / 2 + 2 && Math.abs(p.top - top) < 15);
      if (!hit) break;
      top = hit.top - 16;
    }
    placed.push({ x: a.x, w: tw, top });
    ctx.globalAlpha = on ? 1 : 0.82;
    const lx = clamp(a.x, tw / 2 + 4, g.W - tw / 2 - 4); // the tag stays inside the canvas
    ctx.fillStyle = "rgba(14,12,26,0.78)"; rr(ctx, lx - tw / 2, top - 15, tw, 14, 7); ctx.fill();
    ctx.fillStyle = a.hat; ctx.beginPath(); ctx.arc(lx - tw / 2 + 7, top - 8, 2.4, 0, 7); ctx.fill();
    ctx.fillStyle = "#f3eee6"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, lx - tw / 2 + 12, top - 7.5);
    ctx.globalAlpha = 1;
    if (w.selected === a.id) a.labelTop = top;
  }
  for (const f of w.floats) {
    ctx.globalAlpha = Math.min(1, f.life * 1.4); ctx.font = `700 ${Math.round(10 * s + 4)}px "Chakra Petch", sans-serif`; ctx.textAlign = "center";
    ctx.strokeStyle = "#1a1424"; ctx.lineWidth = 3.5; ctx.strokeText(f.text, f.x, f.y); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  const view = w.hall.view, hb = groundY(g, g.siteX);
  if (phaseOf(w.hall.shown) < 5 || !view) {
    // site board with the spec's number, starting at the site's left edge (clear of the camp sign)
    const bx = g.siteL + 6 * s, by = hb;
    ctx.fillStyle = "#5a3d24"; ctx.fillRect(bx - 1.5 * s, by - 30 * s, 3 * s, 30 * s);
    ctx.font = `700 ${Math.round(8 * s + 3)}px "Chakra Petch", sans-serif`;
    const t = view ? `SPEC #${view.spec}` : "NO SPEC YET", tw = ctx.measureText(t).width + 12;
    ctx.fillStyle = "#e8d3a8"; ctx.strokeStyle = OUT; ctx.lineWidth = 1.5; rr(ctx, g.siteL, by - 44 * s, tw, 15 * s, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#3a2414"; ctx.textAlign = "center"; ctx.fillText(t, g.siteL + tw / 2, by - 36.5 * s);
  }
  if (view && w.selected === "hall") {
    const ph = phaseOf(w.hall.shown);
    bubble(ctx, g, g.siteX, hb - 150 * s, `${short(view.title, 28)} · spec #${view.spec}`, `PHASE ${ph}/5 · ${PHASE_NAMES[ph].toUpperCase()}`, `${view.done} of ${view.total} tickets done${view.pr ? ` · PR #${view.pr}` : ""}.`, "#b5720f");
  }
  for (const m of [w.selected, w.hover]) {
    const i = m?.startsWith("hill:") ? Number(m.slice(5)) : -1, f = skyline(w)[i];
    if (f) { const sp = skylineSpot(g, w, i); bubble(ctx, g, sp.x, sp.y - 54 * s, short(f.title, 28), "FINISHED", `Spec #${f.spec} merged.`, "#18794e"); break; }
  }
}

export function render(ctx: C, g: Geo, w: World) {
  drawBackdrop(ctx, g, w);
  drawGround(ctx, g, w);
  drawCamp(ctx, g, w);
  drawQuarry(ctx, g, w);
  drawHall(ctx, g, w);
  const order = [...w.agents].sort((a, b) => Number(a.id === w.selected) - Number(b.id === w.selected) || a.y - b.y);
  for (const a of order) drawAgent(ctx, a, g, w.selected === a.id, w.hover === a.id, w);
  drawParticles(ctx, w);
  drawLight(ctx, g, w);
  drawLabels(ctx, g, w);
}

/** What's at canvas point (x, y): an agent's id, "hall", "hill:<i>", or null. */
export function pick(w: World, g: Geo, x: number, y: number): string | null {
  let best: string | null = null, bd = 22 * g.s + 6;
  for (const a of w.agents) { const d = Math.hypot(x - a.x, y - (a.y - 18 * g.s)); if (d < bd) { bd = d; best = a.id; } }
  if (best !== null) return best;
  if (w.hall.view && Math.abs(x - g.siteX) < 80 * g.s && y < groundY(g, g.siteX) && y > groundY(g, g.siteX) - 150 * g.s) return "hall";
  const n = skyline(w).length;
  for (let i = 0; i < n; i++) { const sp = skylineSpot(g, w, i); if (Math.abs(x - sp.x) < 22 * g.s && y < sp.y + 6 && y > sp.y - 46 * g.s) return `hill:${i}`; }
  return null;
}
