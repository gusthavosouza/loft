/**
 * The Workers settlement: a pixel scene drawn at 320x180 offscreen and scaled up with smoothing off, text crisp on top.
 * The backlog (quarry, forest) is on the left, the construction site in the centre, the homestead camp on the right,
 * a hill of finished buildings across the top. Agents are its workers; the running Delivery's spec is its hall.
 * Ported from the approved prototype; all art is procedural canvas code.
 */
import { phaseOf, PHASE_NAMES, type HallEvent, type Kind } from "./workers";

type C = CanvasRenderingContext2D;
type Pt = { x: number; y: number };

export const LW = 320;
export const LH = 180;

/** An agent as the settlement needs it. */
export type Worker = {
  id: string;
  name: string;
  kind: Kind;
  roleLabel: string;
  group: string;
  hat: string;
  shirt: string;
  straw: boolean;
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

const S = { RESTING: "RESTING", DISPATCHING: "DISPATCHING", GATHERING: "GATHERING", HAULING: "HAULING", INSPECTING: "INSPECTING", PLANNING: "PLANNING", RETURNING: "RETURNING_TO_CAMP", STANDBY: "STANDBY" } as const;
type St = (typeof S)[keyof typeof S];

type Sim = Worker & {
  n: number;
  x: number; y: number; path: Pt[]; state: St; zone: "backlog" | "site" | "camp";
  spot: Spot | null; seat: Pt; post: Pt; actT: number; carry: "stone" | "timber" | null; frame: number; face: number;
  zT: number; dustT: number; patrol: number; num: number | null; rush: boolean; deliver: number | null;
};
type Spot = { x: number; y: number; kind: "rock" | "tree" };
type Particle = { type: string; x: number; y: number; vx: number; vy: number; life: number; max: number; c?: string; r?: number };
type Float = { x: number; y: number; text: string; color: string; life: number };
type Tree = { x: number; y: number; kind: "oak" | "pine"; seed: number };

export type World = {
  grass: { x: number; y: number; c: string; tuft: boolean }[];
  flowers: { x: number; y: number; c: string }[];
  trees: Tree[];
  agents: Sim[];
  /** The hall: `shown` eases toward `target` (percent done); `view` is null for an empty lot. */
  hall: { view: HallView | null; shown: number; target: number; celebrate: number; celebrating: string | null; next: { view: HallView | null } | null };
  finished: Finished[];
  queue: number[];
  events: HallEvent[];
  particles: Particle[]; floats: Float[]; zs: { x: number; y: number; life: number }[];
  t: number; dayT: number; speed: number; reduced: boolean; smokeT: number;
  selected: string | null; hover: string | null; viewW: number;
};

// trail junctions and places (world pixels)
const B = { x: 88, y: 130 }, SITE = { x: 160, y: 136 }, CAMP = { x: 236, y: 118 };
const HALL = { x: 160, base: 122, w: 84 };
const SPOTS: Spot[] = [
  { x: 26, y: 62, kind: "rock" }, { x: 52, y: 52, kind: "rock" }, { x: 72, y: 78, kind: "rock" }, { x: 30, y: 94, kind: "rock" }, { x: 60, y: 100, kind: "rock" },
  { x: 22, y: 146, kind: "tree" }, { x: 48, y: 156, kind: "tree" }, { x: 74, y: 146, kind: "tree" },
];
const SEATS = [{ x: 258, y: 98 }, { x: 290, y: 98 }, { x: 274, y: 112 }, { x: 252, y: 70 }, { x: 292, y: 70 }, { x: 266, y: 112 }];
const POSTS: Record<string, Pt> = { qa: { x: 108, y: 132 }, security: { x: 214, y: 132 }, reviewer: { x: 124, y: 112 } };
const PATROL = [{ x: 124, y: 132 }, { x: 196, y: 132 }, { x: 206, y: 100 }, { x: 116, y: 100 }];
const HILL = { x0: 104, step: 24, y: 26 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Seat n at the camp: the first six are the benches, the rest spiral out around the fire. */
export function seatFor(n: number): Pt {
  if (n < SEATS.length) return SEATS[n];
  const i = n - SEATS.length + 1;
  const r = 10 + 7 * Math.sqrt(i), a = i * 2.39996;
  return { x: clamp(274 + r * Math.cos(a) * 1.5, 236, 312), y: clamp(104 + r * Math.sin(a) * 0.9, 74, 128) };
}
/** Post k of a checker role: a few abreast, then rows behind. */
function postFor(kind: Kind, k: number): Pt {
  const p = POSTS[kind] ?? POSTS.qa;
  return { x: p.x + (k % 3) * 7 - 7, y: p.y + Math.floor(k / 3) * 5 };
}

export function makeWorld(): World {
  let seed = 31;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return {
    grass: Array.from({ length: 420 }, () => ({ x: (rnd() * LW) | 0, y: (rnd() * LH) | 0, c: rnd() < 0.5 ? "#5fb34a" : "#3f8a35", tuft: rnd() < 0.25 })),
    flowers: Array.from({ length: 40 }, () => ({ x: (rnd() * LW) | 0, y: 40 + ((rnd() * 140) | 0), c: ["#ffe36b", "#ff8fb5", "#ffffff", "#9fd6ff"][(rnd() * 4) | 0] })),
    trees: [
      ...[[8, 120], [96, 166], [104, 150], [312, 150], [300, 172], [228, 168], [140, 170], [312, 40], [226, 30]].map(([x, y]) => ({ x, y, kind: "oak" as const, seed: rnd() * 6 })),
      ...[[6, 172], [34, 176], [62, 172], [86, 176], [250, 160], [188, 172], [306, 100]].map(([x, y]) => ({ x, y, kind: "pine" as const, seed: rnd() * 6 })),
    ],
    agents: [],
    hall: { view: null, shown: 0, target: 0, celebrate: 0, celebrating: null, next: null },
    finished: [], queue: [], events: [], particles: [], floats: [], zs: [],
    t: 0, dayT: 0.47, speed: 1, reduced: false, smokeT: 0, selected: null, hover: null, viewW: 960,
  };
}

/* ---------- data in ---------- */

/** Makes the settlement's agents match `list`: new ones arrive, gone ones leave, the rest keep walking with updated data. */
export function syncAgents(w: World, list: Worker[]) {
  const byId = new Map(w.agents.map((a) => [a.id, a]));
  const kindCount: Record<string, number> = {};
  w.agents = list.map((wk, n) => {
    const k = (kindCount[wk.kind] = (kindCount[wk.kind] ?? -1) + 1);
    const post = postFor(wk.kind, k);
    const old = byId.get(wk.id);
    if (old) return Object.assign(old, wk, { n, seat: seatFor(n), post });
    const dev = wk.kind === "dev", seat = seatFor(n);
    const spot = dev && wk.on ? freeSpotFor(w) : null;
    const start = !wk.on ? seat : dev ? { x: spot!.x - 6, y: spot!.y + 4 } : wk.kind === "lead" ? PATROL[0] : post;
    return {
      ...wk, n, x: start.x, y: start.y + (wk.on ? 0 : 3), path: [], seat, post, spot,
      state: !wk.on ? S.RESTING : dev ? S.GATHERING : wk.kind === "lead" ? S.PLANNING : S.STANDBY,
      zone: !wk.on ? "camp" : dev ? "backlog" : "site", actT: rand(1, 3), carry: null, frame: rand(0, 4), face: 1,
      zT: rand(0, 1.5), dustT: 0, patrol: 1, num: null, rush: false, deliver: null,
    } satisfies Sim;
  });
  if (w.selected && w.selected !== "hall" && !byId.has(w.selected) && !list.some((a) => a.id === w.selected)) w.selected = null;
}

function freeSpotFor(w: World, except?: Sim): Spot {
  const taken = new Set(w.agents.filter((o) => o !== except && o.spot).map((o) => o.spot));
  const free = SPOTS.filter((s) => !taken.has(s));
  const from = free.length ? free : SPOTS;
  return from[(Math.random() * from.length) | 0];
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

/** The merged specs for the hill, newest first; the one being celebrated joins it when the party ends. */
export function setFinished(w: World, merged: Finished[]) {
  w.finished = merged;
}

/** A merge starts its party at once, so the hall isn't swapped for the next one first; the rest wait for the next step. */
export function pushEvent(w: World, e: HallEvent) {
  if (e.type === "merged") handle(w, e);
  else w.events.push(e);
}

/* ---------- simulation ---------- */

const sun = (d: number) => Math.sin(d * Math.PI * 2);
const nightAmount = (d: number) => clamp(-sun(d) * 1.3 + 0.1, 0, 0.6);
const duskAmount = (d: number) => clamp(1 - Math.abs(sun(d)) / 0.35, 0, 1);
function emit(w: World, p: Particle) { if (w.particles.length < 300) w.particles.push(p); }
function float(w: World, x: number, y: number, text: string, color: string) { w.floats.push({ x, y, text, color, life: 1.6 }); }

function routeToBacklog(a: Sim): Pt[] {
  const pre = a.zone === "camp" ? [CAMP, SITE, B] : a.zone === "site" ? [B] : [];
  return [...pre, { x: a.spot!.x + (a.spot!.kind === "rock" ? -6 : -7), y: a.spot!.y + 4 }];
}
function routeToSite(a: Sim): Pt[] {
  const drop = { x: HALL.x + rand(-26, 26), y: HALL.base + 10 };
  return a.zone === "camp" ? [CAMP, drop] : a.zone === "backlog" ? [B, drop] : [drop];
}
function routeToCamp(a: Sim): Pt[] {
  const pre = a.zone === "backlog" ? [B, SITE, CAMP] : a.zone === "site" ? [SITE, CAMP] : [];
  return [...pre, { x: a.seat.x, y: a.seat.y }];
}

/** A Dev reached the site: with a ticket to deliver it shows "+1 #N"; otherwise it was only a haul. */
function deliver(w: World, a: Sim) {
  a.carry = null;
  if (a.deliver !== null) {
    float(w, HALL.x + rand(-16, 16), HALL.base - 30, `+1 #${a.deliver}`, "#ffe066");
    for (let k = 0; k < 8; k++) emit(w, { type: "dust", x: HALL.x + rand(-20, 20), y: HALL.base + 2, vx: rand(-14, 14), vy: rand(-16, -4), life: 0.6, max: 0.6, c: "#d8b882" });
    a.deliver = null;
  }
}

function handle(w: World, e: HallEvent) {
  if (e.type === "review") { if (w.queue.length < 8) w.queue.push(e.number); return; }
  if (e.type === "closed") {
    const devs = w.agents.filter((a) => a.kind === "dev" && a.on);
    const a = devs.find((d) => d.state !== S.HAULING) ?? devs[0];
    if (!a) { float(w, HALL.x + rand(-16, 16), HALL.base - 30, `+1 #${e.number}`, "#ffe066"); return; }
    a.carry = Math.random() < 0.5 ? "stone" : "timber"; a.rush = true; a.deliver = e.number; a.state = S.HAULING; a.spot = null;
    a.path = routeToSite(a);
    return;
  }
  // merged: the hall is complete, with a party
  const h = w.hall;
  if (h.celebrate > 0) return;
  h.celebrate = w.reduced ? 5 : 9; h.shown = 100; h.celebrating = e.key;
  float(w, HALL.x, HALL.base - 70, `${e.title} complete!`, "#ffffff");
}

export function step(w: World, dt: number) {
  const sp = w.speed;
  const anyOn = w.agents.some((a) => a.on);
  w.t += dt;
  w.dayT += ((anyOn ? 0.2 : 0.47) - w.dayT) * Math.min(1, dt * 0.8);
  for (const e of w.events.splice(0)) handle(w, e);
  const h = w.hall;
  if (h.celebrate > 0) {
    h.celebrate -= dt;
    if (!w.reduced && Math.random() < dt * 40) emit(w, { type: "confetti", x: HALL.x + rand(-40, 40), y: HALL.base - 80, vx: rand(-20, 20), vy: rand(-10, 20), life: 2.2, max: 2.2, c: ["#ffe066", "#ff6b8a", "#6fd3ff", "#8dff7a", "#ffffff"][(Math.random() * 5) | 0] });
    if (h.celebrate <= 0) {
      h.celebrating = null;
      const next = h.next; h.next = null; h.shown = 0;
      setHall(w, next ? next.view : null);
    }
  } else h.shown += (h.target - h.shown) * Math.min(1, dt * 2);

  for (const a of w.agents) {
    const walking = a.path.length > 0;
    if (walking) {
      const tgt = a.path[0], dx = tgt.x - a.x, dy = tgt.y - a.y, d = Math.hypot(dx, dy);
      const v = (a.state === S.HAULING ? (a.rush ? 34 : 16) : 22) * sp;
      if (d <= v * dt) { a.x = tgt.x; a.y = tgt.y; a.path.shift(); }
      else { a.x += (dx / d) * v * dt; a.y += (dy / d) * v * dt; if (Math.abs(dx) > 0.3) a.face = Math.sign(dx); }
      a.frame += dt * sp * (a.state === S.HAULING ? 7 : 9);
      a.dustT -= dt * sp;
      if (a.dustT <= 0) { a.dustT = 0.3; emit(w, { type: "dust", x: a.x, y: a.y, vx: rand(-4, 4), vy: rand(-6, -2), life: 0.45, max: 0.45, c: "#d8b882" }); }
    }
    const dev = a.kind === "dev", work = a.on;
    if (!work && a.state !== S.RESTING && a.state !== S.RETURNING && !(a.state === S.HAULING && walking)) {
      a.state = S.RETURNING; a.path = routeToCamp(a); a.carry = null; a.spot = null; a.deliver = null;
    }
    switch (a.state) {
      case S.RESTING:
        a.face = Math.sign(274 - a.x) || 1;
        if (a.n % 2 === 0) { a.zT -= dt; if (a.zT <= 0) { a.zT = 1.5; w.zs.push({ x: a.x + 3, y: a.y - 13, life: 2.4 }); } }
        if (work && !walking) {
          if (dev) { a.spot = freeSpotFor(w, a); a.path = routeToBacklog(a); a.state = S.DISPATCHING; }
          else if (a.kind === "lead") { a.path = [CAMP, PATROL[0]]; a.state = S.PLANNING; a.zone = "camp"; }
          else { a.path = [CAMP, a.post]; a.state = S.STANDBY; a.zone = "camp"; }
        }
        break;
      case S.DISPATCHING:
        if (!walking) { a.state = S.GATHERING; a.zone = "backlog"; a.actT = rand(2.2, 3.6); a.face = 1; }
        break;
      case S.GATHERING:
        a.actT -= dt * sp; a.frame += dt * sp * 5;
        if (Math.floor(a.frame) % 2 === 0 && Math.random() < dt * sp * 8) emit(w, { type: "chip", x: a.x + 6, y: a.y - 3, vx: rand(-8, 14), vy: rand(-22, -8), life: 0.5, max: 0.5, c: a.spot!.kind === "rock" ? "#b9b6c4" : "#c9935a" });
        if (a.actT <= 0) { a.carry = a.spot!.kind === "rock" ? "stone" : "timber"; a.path = routeToSite(a); a.state = S.HAULING; }
        break;
      case S.HAULING:
        if (!walking) {
          a.zone = "site";
          emit(w, { type: "toss", x: a.x, y: a.y - 18, vx: (HALL.x - a.x) * 1.2, vy: -38, life: 0.8, max: 0.8, c: a.carry === "stone" ? "#9a98a6" : "#a8693a" });
          deliver(w, a); a.rush = false;
          if (work) { a.spot = freeSpotFor(w, a); a.path = routeToBacklog(a); a.state = S.DISPATCHING; }
          else { a.path = routeToCamp(a); a.state = S.RETURNING; }
        }
        break;
      case S.STANDBY:
        if (!walking) {
          a.zone = "site"; a.face = Math.sign(HALL.x - a.x) || 1;
          const n = w.queue.shift();
          if (n !== undefined) { a.num = n; a.path = [{ x: HALL.x + rand(-30, 30), y: HALL.base + 6 }]; a.state = S.INSPECTING; a.actT = 2.2; }
        }
        break;
      case S.INSPECTING:
        if (!walking) {
          a.face = Math.sign(HALL.x - a.x) || 1;
          a.actT -= dt * sp;
          if (a.actT <= 0) { float(w, a.x, a.y - 22, `✓ ${a.kind === "qa" ? "QA" : a.kind === "security" ? "SEC" : "REV"} #${a.num}`, "#8dff7a"); a.path = [a.post]; a.state = S.STANDBY; }
        }
        break;
      case S.PLANNING:
        if (!walking) { a.actT -= dt * sp; if (a.actT <= 0) { a.patrol = (a.patrol + 1) % PATROL.length; a.path = [PATROL[a.patrol]]; a.actT = rand(1.5, 3); a.zone = "site"; } }
        break;
      case S.RETURNING:
        if (!walking) { a.state = S.RESTING; a.zone = "camp"; }
        break;
    }
  }

  // chimney smoke, embers, fireflies
  w.smokeT -= dt * sp;
  if (w.smokeT <= 0) { w.smokeT = 0.5; emit(w, { type: "smoke", x: 287 + rand(-1, 1), y: 6, vx: rand(-5, -2), vy: rand(-7, -4), life: 3.4, max: 3.4, r: 1.5 }); }
  if (Math.random() < dt * sp * 10) emit(w, { type: "spark", x: 274 + rand(-2, 2), y: 102, vx: rand(-4, 4), vy: rand(-22, -10), life: rand(0.5, 1.1), max: 1.1, c: "#ffcf5a" });
  if (nightAmount(w.dayT) > 0.2 && Math.random() < dt * 3) emit(w, { type: "firefly", x: rand(0, LW), y: rand(30, LH), vx: rand(-4, 4), vy: rand(-3, 3), life: 4, max: 4 });
  for (const p of w.particles) {
    p.life -= dt * (p.type === "firefly" ? 1 : sp);
    p.x += p.vx * dt * sp; p.y += p.vy * dt * sp;
    if (p.type === "dust" || p.type === "chip" || p.type === "toss") p.vy += 70 * dt * sp;
    if (p.type === "confetti") { p.vy += 18 * dt; p.vx *= 0.99; }
    if (p.type === "smoke") p.r = (p.r ?? 1) + dt * sp * 1.1;
  }
  w.particles = w.particles.filter((p) => p.life > 0);
  for (const f of w.floats) { f.life -= dt; f.y -= dt * 10; }
  w.floats = w.floats.filter((f) => f.life > 0);
  for (const z of w.zs) { z.life -= dt; z.y -= dt * 6; z.x += dt * 2; }
  w.zs = w.zs.filter((z) => z.life > 0);
}

/* ---------- pixel drawing ---------- */


function px(c: C, x: number, y: number, w: number, h: number, col: string) { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); }
function disc(c: C, cx: number, cy: number, r: number, col: string) {
  c.fillStyle = col; cx = Math.round(cx); cy = Math.round(cy);
  for (let dy = -r; dy <= r; dy++) { const hw = Math.floor(Math.sqrt(r * r - dy * dy + r * 0.8)); c.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1); }
}
function line(c: C, pts: Pt[], w: number, col: string) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let k = 0; k <= n; k++) px(c, a.x + (b.x - a.x) * k / n - w / 2, a.y + (b.y - a.y) * k / n - w / 2, w, w, col);
  }
}

function drawGround(c: C, w: World) {
  px(c, 0, 0, LW, LH, "#4e9a3d");
  for (const g of w.grass) { px(c, g.x, g.y, 1, 1, g.c); if (g.tuft) { px(c, g.x - 1, g.y - 1, 1, 1, "#6cc456"); px(c, g.x + 1, g.y - 1, 1, 1, "#6cc456"); } }
  // the hill where finished buildings stand
  for (let x = 96; x < 228; x++) { const hgt = 30 + Math.round(Math.sin((x - 96) / 132 * Math.PI) * 4); px(c, x, 0, 1, hgt, "#5aa846"); px(c, x, hgt, 1, 1, "#3f8a35"); }
  // backlog quarry: rough ground with boulders
  disc(c, 46, 76, 36, "#8a6a4a"); disc(c, 30, 96, 22, "#8a6a4a"); disc(c, 46, 76, 33, "#9c7a55");
  for (let k = 0; k < 40; k++) px(c, 18 + (k * 37) % 60, 48 + (k * 53) % 58, 1, 1, k % 2 ? "#7a5a3c" : "#b08d63");
  // trails
  const trail = [{ x: 82, y: 104 }, B, SITE, { x: 200, y: 130 }, CAMP, { x: 268, y: 92 }, { x: 274, y: 76 }];
  line(c, trail, 9, "#9c7444"); line(c, trail, 7, "#c39a5f");
  line(c, [{ x: 82, y: 112 }, { x: 60, y: 140 }], 5, "#c39a5f");
  for (const [x, y] of [[270, 78], [275, 82], [271, 86], [276, 90]]) { px(c, x, y, 3, 2, "#9a9aa6"); px(c, x, y, 3, 1, "#b9b9c4"); }
  for (const f of w.flowers) { if (f.x < 92 && f.y < 120) continue; px(c, f.x, f.y, 1, 1, f.c); px(c, f.x, f.y + 1, 1, 1, "#3c7d2e"); }
  // construction yard: packed dirt
  px(c, 110, 98, 100, 32, "#a8824f"); px(c, 112, 96, 96, 2, "#a8824f"); px(c, 110, 129, 100, 1, "#8a6a3c");
  for (let k = 0; k < 30; k++) px(c, 112 + (k * 29) % 96, 100 + (k * 17) % 28, 1, 1, "#93703f");
}

function drawBacklog(c: C) {
  // sign
  px(c, 86, 92, 2, 14, "#6b4423"); px(c, 78, 86, 20, 8, "#c08a52"); px(c, 78, 86, 20, 1, "#d9a86c"); px(c, 78, 93, 20, 1, "#7a4e28");
  for (const s of SPOTS) {
    if (s.kind === "rock") {
      disc(c, s.x, s.y, 6, "#6e6b79"); disc(c, s.x - 1, s.y - 1, 5, "#8d8a97"); disc(c, s.x - 2, s.y - 3, 2, "#b9b6c4");
      px(c, s.x + 2, s.y, 2, 1, "#f4c542"); px(c, s.x - 3, s.y + 2, 1, 1, "#6fd3ff");
    }
  }
}

function drawTree(c: C, t: Tree, w: World, choppable: boolean) {
  const sw = Math.round(Math.sin(w.t * 0.9 + t.seed) * 0.7);
  px(c, t.x - 6, t.y + 12, 13, 3, "rgba(0,0,0,0.18)");
  if (t.kind === "oak") {
    px(c, t.x - 1, t.y + 4, 3, 10, "#6b4423"); px(c, t.x, t.y + 4, 1, 10, "#8a5a30");
    disc(c, t.x + sw, t.y, 8, "#2f7a35"); disc(c, t.x - 4 + sw, t.y + 2, 5, "#2f7a35"); disc(c, t.x + 4 + sw, t.y + 2, 5, "#2f7a35");
    disc(c, t.x - 1 + sw, t.y - 2, 6, "#3f9a40"); disc(c, t.x - 3 + sw, t.y - 4, 3, "#5cb84d");
    px(c, t.x + 3 + sw, t.y - 1, 1, 1, "#e0473a");
  } else {
    px(c, t.x, t.y + 8, 2, 6, "#6b4423");
    for (let r = 0; r < 4; r++) { const wd = 3 + r * 3, y = t.y - 6 + r * 4; px(c, t.x + 1 - Math.floor(wd / 2) + (r < 2 ? sw : 0), y, wd, 4, r % 2 ? "#1f5e36" : "#2a7342"); }
    px(c, t.x, t.y - 8, 2, 2, "#2a7342");
  }
  if (choppable) { px(c, t.x - 2, t.y + 11, 5, 2, "#c9935a"); }
}

function drawHall(c: C, pct: number, w: World) {
  const ph = phaseOf(pct), x0 = HALL.x - HALL.w / 2, x1 = HALL.x + HALL.w / 2, base = HALL.base;
  const q = (lo: number, hi: number) => clamp((pct - lo) / (hi - lo), 0, 1);
  // foundation: dirt pad, stakes and string, blueprints
  px(c, x0 - 2, base - 3, HALL.w + 4, 5, "#7a4f2c"); px(c, x0 - 2, base - 3, HALL.w + 4, 1, "#93623a");
  const stake = (x: number) => { px(c, x, base - 9, 2, 8, "#c49a62"); px(c, x, base - 9, 2, 1, "#e8c48a"); };
  if (ph === 1) {
    stake(x0); stake(x1 - 2); stake(x0 + 20); stake(x1 - 22);
    px(c, x0, base - 7, HALL.w, 1, "#f3efe2");
    const stones = Math.floor(q(0, 25) * 14);
    for (let k = 0; k < stones; k++) px(c, x0 + 3 + k * 6, base - 2, 5, 2, k % 2 ? "#8d8a97" : "#a9a6b3");
    px(c, HALL.x - 10, base + 3, 18, 5, "#3d6fb3"); for (let k = 0; k < 4; k++) px(c, HALL.x - 8 + k * 4, base + 4, 1, 3, "#cfe3ff"); px(c, HALL.x - 8, base + 5, 14, 1, "#cfe3ff");
    return;
  }
  // stone base
  const baseH = ph === 2 ? Math.max(2, Math.round(q(25, 50) * 12)) : 12;
  for (let r = 0; r < baseH; r += 3) for (let x = x0; x < x1; x += 6) {
    const off = (r / 3) % 2 ? 3 : 0;
    px(c, x + off, base - 3 - r - 3, Math.min(5, x1 - x - off), 3, (x + r) % 4 ? "#9a98a6" : "#86849a");
    px(c, x + off, base - 3 - r - 3, Math.min(5, x1 - x - off), 1, "#b9b6c4");
  }
  const top = base - 15;
  const scaff = () => {
    for (const x of [x0 - 6, x1 + 4]) { px(c, x, top - 52, 2, 52, "#a8774a"); px(c, x + 6 * (x < HALL.x ? 1 : -1) - 1, top - 52, 2, 52, "#8a5f37"); }
    for (const y of [top - 14, top - 30, top - 46]) { px(c, x0 - 7, y, 10, 2, "#c99a62"); px(c, x1 - 3, y, 10, 2, "#c99a62"); }
  };
  if (ph === 2) { scaff(); px(c, x0 - 20, base - 6, 10, 6, "#9a98a6"); px(c, x0 - 18, base - 9, 6, 3, "#b9b6c4"); return; }
  // timber frame + walls
  const wallH = 34, wallTop = top - wallH;
  const fill = ph === 3 ? q(50, 75) : 1;
  const plankRows = Math.floor(fill * (wallH / 3));
  for (let r = 0; r < plankRows; r++) { px(c, x0 + 2, top - 3 - r * 3, HALL.w - 4, 3, r % 2 ? "#b07a45" : "#a06a3a"); px(c, x0 + 2, top - 3 - r * 3, HALL.w - 4, 1, "#c99060"); }
  for (let x = x0; x <= x1 - 3; x += 14) px(c, x, wallTop, 3, wallH, "#6b4423");
  px(c, x0, wallTop, HALL.w, 3, "#6b4423"); px(c, x0, top - 18, HALL.w, 2, "#7a4e28");
  if (ph === 3) {
    scaff();
    px(c, x1 + 8, top - 30, 1, 30, "#c99a62"); px(c, x1 + 13, top - 30, 1, 30, "#c99a62"); for (let y = top - 28; y < top; y += 4) px(c, x1 + 8, y, 6, 1, "#c99a62");
    return;
  }
  // windows and door (lit when complete or at dusk)
  const lit = ph === 5 || nightAmount(w.dayT) > 0.15;
  for (const wx of [x0 + 8, x0 + 24, x1 - 32, x1 - 16]) { px(c, wx - 1, wallTop + 8, 10, 10, "#4f3218"); px(c, wx, wallTop + 9, 8, 8, lit ? "#ffd27a" : "#8fc8e6"); px(c, wx + 3, wallTop + 9, 1, 8, "#4f3218"); px(c, wx, wallTop + 12, 8, 1, "#4f3218"); }
  px(c, HALL.x - 7, top - 20, 14, 20, "#4f3218"); px(c, HALL.x - 6, top - 19, 12, 19, "#7a4a24"); px(c, HALL.x + 3, top - 10, 1, 1, "#f1c75b");
  // roof, tile rows growing up from the eaves
  const rows = 14, built = ph === 4 ? Math.max(1, Math.floor(q(75, 100) * rows)) : rows;
  for (let r = 0; r < built; r++) {
    const y = wallTop - 2 - r * 2, inset = r * 3;
    px(c, x0 - 6 + inset, y, HALL.w + 12 - inset * 2, 2, r % 2 ? "#c4583a" : "#d36a45");
    for (let x = x0 - 4 + inset + (r % 2) * 3; x < x1 + 6 - inset; x += 6) px(c, x, y, 1, 2, "#a3412b");
  }
  if (ph === 4) { scaff(); return; }
  // complete: chimney, banner, sign
  px(c, x1 - 22, wallTop - 26, 7, 14, "#8d8a97"); px(c, x1 - 23, wallTop - 27, 9, 2, "#6e6b79");
  px(c, HALL.x, wallTop - 40, 1, 14, "#5a3519");
  const wave = Math.round(Math.sin(w.t * 5));
  px(c, HALL.x + 1, wallTop - 40, 9, 5 + wave, "#e8a33b"); px(c, HALL.x + 1, wallTop - 38, 9, 1, "#fff1a8");
  px(c, HALL.x - 16, top - 26, 32, 6, "#e8d3a8"); px(c, HALL.x - 16, top - 26, 32, 1, "#fff6dc");
}

function drawCamp(c: C, w: World) {
  c.save(); c.translate(222, 0);
  px(c, 22, 58, 58, 3, "rgba(0,0,0,0.18)");
  px(c, 24, 34, 54, 24, "#a8693a"); for (let y = 36; y < 58; y += 4) px(c, 24, y, 54, 1, "#8a5228");
  px(c, 22, 58, 58, 6, "#c08a52"); for (let x = 24; x < 80; x += 6) px(c, x, 58, 1, 6, "#9c6a3a");
  const lit = clamp(nightAmount(w.dayT) * 1.6 + duskAmount(w.dayT) * 0.6, 0, 1);
  px(c, 46, 44, 9, 14, "#5a3519"); px(c, 47, 45, 7, 13, "#7a4a24");
  for (const wx of [30, 63]) { px(c, wx - 1, 40, 10, 9, "#5a3519"); px(c, wx, 41, 8, 7, lit > 0.2 ? "#ffd27a" : "#8fc8e6"); px(c, wx + 3, 41, 1, 7, "#5a3519"); px(c, wx - 1, 49, 10, 2, "#6fb04a"); px(c, wx + 2, 48, 1, 1, "#ff8fb5"); }
  for (let r = 0; r < 11; r++) { const y = 14 + r * 2, inset = 10 - r; px(c, 20 + inset, y, 62 - inset * 2, 2, r % 2 ? "#c4583a" : "#d36a45"); for (let x = 22 + inset + (r % 2) * 3; x < 80 - inset; x += 6) px(c, x, y, 1, 2, "#a3412b"); }
  px(c, 18, 36, 66, 2, "#8f3a24");
  px(c, 62, 6, 8, 16, "#8d8a97"); for (let y = 7; y < 22; y += 3) px(c, 62, y, 8, 1, "#6e6b79"); px(c, 61, 5, 10, 2, "#6e6b79");
  c.restore();
  // fire pit and log benches
  const log = (x: number, y: number, wd: number) => { px(c, x, y, wd, 4, "#7a4a24"); px(c, x, y, wd, 1, "#a8693a"); px(c, x, y + 1, 1, 2, "#d7a86e"); px(c, x + wd - 1, y + 1, 1, 2, "#d7a86e"); };
  log(252, 99, 12); log(284, 99, 12); log(267, 114, 14);
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; px(c, 274 + Math.cos(a) * 7 - 1, 105 + Math.sin(a) * 4 - 1, 3, 2, k % 2 ? "#8d8a97" : "#a9a6b3"); }
  const f = Math.sin(w.t * 14) > 0 ? 1 : 0, g = Math.sin(w.t * 9 + 1) > 0 ? 1 : 0;
  px(c, 270, 100 + f, 8, 4 - f, "#e2452f"); px(c, 271, 97 + g, 6, 5, "#f07a2c"); px(c, 272, 95 + f, 4, 5, "#ffb93c"); px(c, 273, 93 + g, 2, 4, "#ffe58a");
}

function drawParticles(c: C, w: World) {
  for (const p of w.particles) {
    const k = clamp(p.life / p.max, 0, 1);
    if (p.type === "smoke") { c.globalAlpha = 0.55 * k; disc(c, p.x, p.y, Math.round(p.r ?? 1), "#d9d4e2"); }
    else if (p.type === "firefly") { c.globalAlpha = (Math.sin(w.t * 8 + p.x) > 0 ? 1 : 0.3) * Math.min(1, k * 2); px(c, p.x, p.y, 1, 1, "#f6ff9a"); }
    else if (p.type === "toss") { c.globalAlpha = 1; px(c, p.x - 2, p.y - 2, 4, 3, p.c ?? "#fff"); }
    else if (p.type === "confetti") { c.globalAlpha = k; px(c, p.x, p.y, 2, 1 + (Math.floor(w.t * 8 + p.x) % 2), p.c ?? "#fff"); }
    else { c.globalAlpha = k; px(c, p.x, p.y, 1, 1, p.c ?? "#fff"); }
  }
  c.globalAlpha = 1;
}

function drawLighting(c: C, w: World) {
  const night = nightAmount(w.dayT), dusk = duskAmount(w.dayT);
  c.fillStyle = `rgba(255,214,140,${0.07 * (1 - dusk)})`; c.fillRect(0, 0, LW, LH);
  if (dusk > 0) { c.fillStyle = `rgba(255,150,70,${0.16 * dusk})`; c.fillRect(0, 0, LW, LH); }
  c.fillStyle = `rgba(24,26,72,${night})`; c.fillRect(0, 0, LW, LH);
  const lights = clamp(night * 1.6 + dusk * 0.5, 0, 1);
  c.save(); c.globalCompositeOperation = "lighter";
  const glow = (x: number, y: number, r: number, rgb: string, a: number) => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); };
  glow(274, 100, 30 * (1 + 0.08 * Math.sin(w.t * 12)), "255,140,60", 0.18 + 0.32 * lights);
  if (lights > 0.05) { glow(256, 44, 14, "255,200,110", 0.35 * lights); glow(289, 44, 14, "255,200,110", 0.35 * lights); }
  if (phaseOf(w.hall.shown) === 5 || lights > 0.1) glow(HALL.x, HALL.base - 40, 50, "255,210,120", 0.22 + 0.2 * lights);
  c.restore();
}

/** An empty lot: dirt pad, stakes and string, blueprints, waiting for a spec. */
function drawLot(c: C, w: World) {
  const x0 = HALL.x - HALL.w / 2, x1 = HALL.x + HALL.w / 2, base = HALL.base;
  px(c, x0 - 2, base - 3, HALL.w + 4, 5, "#7a4f2c"); px(c, x0 - 2, base - 3, HALL.w + 4, 1, "#93623a");
  for (const x of [x0, x1 - 2, x0 + 20, x1 - 22]) { px(c, x, base - 9, 2, 8, "#c49a62"); px(c, x, base - 9, 2, 1, "#e8c48a"); }
  px(c, x0, base - 7, HALL.w, 1, "#f3efe2");
  px(c, HALL.x - 10, base + 3, 18, 5, "#3d6fb3"); for (let k = 0; k < 4; k++) px(c, HALL.x - 8 + k * 4, base + 4, 1, 3, "#cfe3ff"); px(c, HALL.x - 8, base + 5, 14, 1, "#cfe3ff");
  px(c, x0 + 6, base + 4, 12, 4, "#e8d3a8"); px(c, x0 + 6, base + 4, 12, 1, "#fff6dc");
  const b = Math.floor(w.t * 1.5) % 2; // the lot's lantern blinks
  px(c, HALL.x + 22, base - 12, 1, 12, "#5a3519"); px(c, HALL.x + 20, base - 15 - b, 5, 4, "#ffd27a");
}

function drawSkyline(c: C, w: World) {
  // finished buildings on the hill: one per merged spec, oldest at the left
  const list = w.finished.filter((f) => f.key !== w.hall.celebrating).slice(0, 5).reverse();
  list.forEach((_, i) => {
    const x = HILL.x0 + i * HILL.step, y = HILL.y;
    px(c, x, y - 10, 18, 10, "#b07a45"); for (let r = 0; r < 4; r++) px(c, x - 2 + r * 2, y - 12 - r * 2, 22 - r * 4, 2, r % 2 ? "#c4583a" : "#d36a45");
    px(c, x + 3, y - 7, 3, 3, "#ffd27a"); px(c, x + 12, y - 7, 3, 3, "#ffd27a"); px(c, x + 7, y - 6, 4, 6, "#5a3519");
    px(c, x + 9, y - 24, 1, 6, "#5a3519"); px(c, x + 10, y - 24, 4, 3, "#e8a33b");
  });
}

function drawAgent(c: C, a: Sim, w: World) {
  const x = Math.round(a.x), y = Math.round(a.y);
  const walking = a.path.length > 0, sitting = a.state === S.RESTING && !walking;
  const gathering = a.state === S.GATHERING, carrying = !!a.carry;
  const step = walking ? Math.floor(a.frame) % 4 : 0, bob = walking && (step === 1 || step === 3) ? -1 : 0;
  const low = sitting ? 3 : 0, dir = a.face;
  if (w.selected === a.id || w.hover === a.id) {
    const on = w.selected === a.id ? (Math.floor(w.t * 4) % 2 ? "#ffd84a" : "#fff1a0") : "rgba(255,255,255,0.7)";
    px(c, x - 5, y + 1, 11, 1, on); px(c, x - 6, y, 1, 1, on); px(c, x + 6, y, 1, 1, on); px(c, x - 5, y - 1, 1, 1, on); px(c, x + 5, y - 1, 1, 1, on);
  }
  px(c, x - 3, y, 7, 2, "rgba(0,0,0,0.25)");
  const top = y - 13 + low + bob;
  if (!sitting) {
    const l = step === 1 ? -1 : 0, r = step === 3 ? -1 : 0;
    px(c, x - 2, top + 9 + l, 2, 4 + (l ? 1 : 0), "#3b3350"); px(c, x + 1, top + 9 + r, 2, 4 + (r ? 1 : 0), "#3b3350");
    px(c, x - 2, y - 1, 2, 1, "#5a3519"); px(c, x + 1, y - 1, 2, 1, "#5a3519");
  } else px(c, x - 2 + dir, top + 10, 5, 2, "#3b3350");
  px(c, x - 3, top + 5, 7, 5, a.shirt); px(c, x - 3, top + 5, 7, 1, "rgba(255,255,255,0.18)");
  const skin = "#f2c29b";
  if (carrying) { px(c, x - 4, top + 1, 1, 5, a.shirt); px(c, x + 4, top + 1, 1, 5, a.shirt); px(c, x - 4, top, 1, 1, skin); px(c, x + 4, top, 1, 1, skin); }
  else if (gathering) {
    const up = Math.floor(a.frame) % 2 === 0;
    const hx = x + dir * 4;
    if (up) { px(c, hx, top + 1, 1, 5, a.shirt); px(c, hx, top, 1, 1, skin); px(c, hx - dir * 2, top - 6, 1, 7, "#8a5f37"); px(c, hx - dir * 4, top - 7, 5, 2, a.spot && a.spot.kind === "tree" ? "#c9ccd9" : "#9a9cad"); }
    else { px(c, hx, top + 6, dir > 0 ? 3 : 1, 1, a.shirt); px(c, hx + dir * 2, top + 6, 1, 1, skin); px(c, hx + dir * 3, top + 2, 6, 1, "#8a5f37"); px(c, hx + dir * 8, top + 1, 2, 5, a.spot && a.spot.kind === "tree" ? "#c9ccd9" : "#9a9cad"); }
    px(c, x - dir * 4, top + 6, 1, 3, a.shirt);
  } else {
    const sw = walking ? (step === 1 ? 1 : step === 3 ? -1 : 0) : 0;
    px(c, x - 4, top + 6 + sw, 1, 3, a.shirt); px(c, x + 4, top + 6 - sw, 1, 3, a.shirt); px(c, x - 4, top + 9 + sw, 1, 1, skin); px(c, x + 4, top + 9 - sw, 1, 1, skin);
    if (a.state === S.INSPECTING || a.state === S.STANDBY) { px(c, x + dir * 4 - 1, top + 6, 4, 5, "#a8774a"); px(c, x + dir * 4, top + 7, 2, 3, "#f3efe2"); }
    if (a.state === S.PLANNING) { px(c, x + dir * 3, top + 6, 6, 4, "#3d6fb3"); px(c, x + dir * 3 + 1, top + 7, 4, 1, "#cfe3ff"); }
  }
  const sleepy = sitting && a.n % 2 === 0;
  px(c, x - 3, top, 7, 6, skin); px(c, x - 3, top + 5, 7, 1, "#e0a87e");
  if (sleepy) px(c, x - 1 + dir, top + 3, 2, 1, "#2a2236"); else { px(c, x - 1 + dir, top + 2, 1, 2, "#2a2236"); px(c, x + 1 + dir, top + 2, 1, 2, "#2a2236"); }
  px(c, x + (dir > 0 ? 2 : -3), top + 4, 1, 1, "#f08a7a");
  if (a.straw) { px(c, x - 5, top, 11, 2, "#e9c46a"); px(c, x - 5, top + 1, 11, 1, "#c9a24a"); px(c, x - 3, top - 3, 7, 3, "#f1d27f"); px(c, x - 3, top - 1, 7, 1, a.hat); }
  else { px(c, x - 3, top - 2, 7, 3, a.hat); px(c, x - 2, top - 2, 3, 1, "rgba(255,255,255,0.35)"); px(c, x + (dir > 0 ? 2 : -5), top, 4, 1, a.hat); }
  if (carrying) {
    const cy = top - 7;
    if (a.carry === "stone") { px(c, x - 3, cy, 7, 5, "#9a98a6"); px(c, x - 3, cy, 7, 1, "#c9c6d4"); px(c, x, cy + 1, 1, 4, "#7a7888"); }
    else { px(c, x - 4, cy + 1, 9, 2, "#8a5a30"); px(c, x - 4, cy + 3, 9, 2, "#a06a3a"); px(c, x - 4, cy + 1, 1, 4, "#d7a86e"); px(c, x + 4, cy + 1, 1, 4, "#d7a86e"); }
  }
  if (a.need) {
    const b = Math.floor(w.t * 3) % 2;
    px(c, x + 5, top - 12, 1, 12, "#6b4423"); px(c, x + 1, top - 19 - b, 10, 8, "#ffd84a"); px(c, x + 1, top - 19 - b, 10, 1, "#fff1a8");
    px(c, x + 5, top - 17 - b, 2, 3, "#c4362c"); px(c, x + 5, top - 13 - b, 2, 1, "#c4362c");
  }
}

export function render(c: C, w: World) {
  drawGround(c, w);
  drawSkyline(c, w);
  drawBacklog(c);
  drawCamp(c, w);
  const items = [
    ...w.trees.map((t) => ({ y: t.y + 12, draw: () => drawTree(c, t, w, false) })),
    ...SPOTS.filter((s) => s.kind === "tree").map((s) => ({ y: s.y + 12, draw: () => drawTree(c, { x: s.x, y: s.y - 6, kind: "oak", seed: s.x }, w, true) })),
    { y: HALL.base, draw: () => (w.hall.view ? drawHall(c, w.hall.shown, w) : drawLot(c, w)) },
    ...w.agents.map((a) => ({ y: a.y, draw: () => drawAgent(c, a, w) })),
  ].sort((p, q) => p.y - q.y);
  for (const it of items) it.draw();
  drawParticles(c, w);
  drawLighting(c, w);
}

/* ---------- crisp overlay: signs, floating text, bubbles ---------- */

/** What an agent is doing, from real data: the ticket or Delivery it's on. */
export function taskLine(a: Worker & { state?: string; num?: number | null }, w: World): string {
  const h = w.hall.view;
  const spec = h ? `spec #${h.spec}: ${h.title}` : "";
  if (a.need && a.state === S.RESTING) return "Needs your answer";
  switch (a.state) {
    case S.RESTING: return a.on ? "Heading out" : "Resting at the homestead";
    case S.DISPATCHING: case S.GATHERING: case S.HAULING:
      return a.ticket ? `Building #${a.ticket.number}: ${a.ticket.title}` : h ? `Gathering materials for ${h.title}` : a.status || "Working";
    case S.INSPECTING: return `${a.kind === "qa" ? "Testing" : a.kind === "security" ? "Security-checking" : "Reviewing"} ticket #${a.num}`;
    case S.STANDBY: return "Waiting for a ticket to inspect";
    case S.PLANNING: return h ? `Planning ${spec}` : "Planning";
    case S.RETURNING: return "Shift over, walking home";
    default: return a.status || "";
  }
}
export const stateLabel = (s: string) => s.replace(/_/g, " ").toLowerCase();

const FONT = (sz: number) => `${Math.round(sz)}px "Pixelify Sans", "VT323", ui-monospace, monospace`;

function bubble(o: C, w: World, ax: number, ay: number, title: string, body: string, extra: string, k: number) {
  o.font = FONT(Math.max(12, k * 3.4));
  const lines = [title, body, extra].filter(Boolean);
  const lh = Math.max(14, k * 4.2), bw = Math.min(Math.max(...lines.map((l) => o.measureText(l).width)) + 24, w.viewW - 12), bh = lh * lines.length + 14;
  const bx = clamp(ax - bw / 2, 6, w.viewW - bw - 6), by = Math.max(6, ay - bh - 14);
  o.fillStyle = "#2a1a10"; o.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
  o.fillStyle = "#f3e2b8"; o.fillRect(bx, by, bw, bh); o.fillStyle = "#e3cd98"; o.fillRect(bx, by + bh - 3, bw, 3);
  o.fillStyle = "#2a1a10"; o.fillRect(ax - 5, by + bh + 3, 10, 3); o.fillRect(ax - 3, by + bh + 6, 6, 3); o.fillRect(ax - 1, by + bh + 9, 2, 3);
  o.textAlign = "left"; o.fillStyle = "#7a3d18"; o.fillText(title, bx + 10, by + 7 + lh / 2);
  o.font = FONT(Math.max(11, k * 3)); o.fillStyle = "#3a2414";
  lines.slice(1).forEach((l, i) => o.fillText(l, bx + 10, by + 7 + lh / 2 + (i + 1) * lh));
}

function tag(o: C, text: string, ax: number, ay: number, k: number) {
  o.font = FONT(Math.max(12, k * 3.4)); o.textAlign = "center";
  const tw = o.measureText(text).width + 14;
  o.fillStyle = "#2a1a10"; o.fillRect(ax - tw / 2 - 2, ay - 22, tw + 4, 20); o.fillStyle = "#f3e2b8"; o.fillRect(ax - tw / 2, ay - 20, tw, 16);
  o.fillStyle = "#3a2414"; o.fillText(text, ax, ay - 11.5);
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function drawOverlay(o: C, w: World, k: number) {
  o.textBaseline = "middle"; o.textAlign = "center";
  o.font = FONT(Math.max(9, k * 2.4)); o.fillStyle = "#3a2414"; o.fillText("BACKLOG", 88 * k, 90 * k);
  const h = w.hall.view;
  if (h && phaseOf(w.hall.shown) === 5) { o.font = FONT(Math.max(9, k * 2.4)); o.fillText(short(h.title.toUpperCase(), 14), HALL.x * k, (HALL.base - 23) * k); }
  if (!h) { o.font = FONT(Math.max(9, k * 2.6)); o.fillStyle = "#fff6dc"; o.strokeStyle = "#2a1a10"; o.lineWidth = Math.max(3, k); o.strokeText("Waiting for a spec", HALL.x * k, (HALL.base - 22) * k); o.fillText("Waiting for a spec", HALL.x * k, (HALL.base - 22) * k); }
  for (const z of w.zs) {
    o.globalAlpha = Math.min(1, z.life); o.font = FONT(k * 5 + 4); o.fillStyle = "#eef3ff"; o.strokeStyle = "#2a2236"; o.lineWidth = Math.max(2, k * 0.7);
    o.strokeText("z", z.x * k, z.y * k); o.fillText("z", z.x * k, z.y * k);
  }
  for (const f of w.floats) {
    o.globalAlpha = Math.min(1, f.life * 1.5); o.font = FONT(Math.max(13, k * 4)); o.fillStyle = f.color; o.strokeStyle = "#2a1a10"; o.lineWidth = Math.max(3, k);
    o.strokeText(f.text, f.x * k, f.y * k); o.fillText(f.text, f.x * k, f.y * k);
  }
  o.globalAlpha = 1;
  if (h && (w.selected === "hall" || w.hover === "hall")) {
    const ph = phaseOf(w.hall.shown);
    bubble(o, w, HALL.x * k, (HALL.base - 60) * k, `${short(h.title, 30)} · spec #${h.spec}`, `Phase ${ph}/5 · ${PHASE_NAMES[ph]}`, `${h.done}/${h.total} tickets${h.pr ? ` · PR #${h.pr}` : ""}`, k);
  }
  for (const m of [w.selected, w.hover]) {
    const i = m?.startsWith("hill:") ? Number(m.slice(5)) : -1;
    const list = w.finished.filter((f) => f.key !== w.hall.celebrating).slice(0, 5).reverse();
    if (i >= 0 && list[i]) { tag(o, `${short(list[i].title, 28)} · spec #${list[i].spec}`, (HILL.x0 + i * HILL.step + 9) * k, (HILL.y - 26) * k + 22, k); break; }
  }
  for (const a of w.agents) {
    if (w.hover !== a.id || w.selected === a.id) continue;
    tag(o, a.initials ? `${a.name} · ${a.initials}` : a.name, a.x * k, (a.y - (a.carry ? 22 : a.need ? 34 : 16)) * k, k);
  }
}

/** What's at world point (x, y): an agent's id, "hall", "hill:<i>", or null. */
export function pick(w: World, x: number, y: number): string | null {
  let best: string | null = null, bd = 9;
  for (const a of w.agents) { const d = Math.hypot(x - a.x, y - (a.y - 7)); if (d < bd) { bd = d; best = a.id; } }
  if (best !== null) return best;
  if (w.hall.view && Math.abs(x - HALL.x) < HALL.w / 2 + 4 && y > HALL.base - 70 && y < HALL.base + 4) return "hall";
  const n = Math.min(5, w.finished.filter((f) => f.key !== w.hall.celebrating).length);
  for (let i = 0; i < n; i++) if (x >= HILL.x0 + i * HILL.step - 2 && x <= HILL.x0 + i * HILL.step + 20 && y >= HILL.y - 26 && y <= HILL.y) return `hill:${i}`;
  return null;
}

