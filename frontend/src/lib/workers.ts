/** The Workers page's pure parts: an agent's worker state, its group's look, and the scene's layout. */

export type WorkerState = "digging" | "resting";

/** Digging while the agent runs a run, resting otherwise. */
export function workerState(agent: { status: string }): WorkerState {
  return agent.status === "running" ? "digging" : "resting";
}

/** Hat colors that read well on the dark scene. */
export const HAT_COLORS = ["#f2b632", "#f27d6d", "#7fd99a", "#8cb8ff", "#b99bff", "#f28fc4", "#5fd3d0", "#f2955f"];
/** Agents with no group share this. */
export const NEUTRAL_HAT = "#9aa0a6";

/** FNV-1a: the same label gives the same number in every browser and on every reload. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/** A group's initials, 1–3 letters: its words' first letters (up to 3), or the first two letters of a single word. */
export function initials(label: string): string {
  const words = label.trim().split(/[\s_\-./]+/).filter(Boolean);
  if (!words.length) return "";
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : words.slice(0, 3).map((w) => [...w][0]);
  return letters.join("").toUpperCase();
}

/** The look of a worker from its agent's group label (a group is only a label): hat color and T-shirt initials. No group: neutral. */
export function groupLook(agent: { group?: string }): { hat: string; initials: string } {
  const label = agent.group?.trim() ?? "";
  if (!label) return { hat: NEUTRAL_HAT, initials: "" };
  return { hat: HAT_COLORS[hash(label.toLowerCase()) % HAT_COLORS.length], initials: initials(label) };
}

/** Where something stands in the scene: its centre x and the y of its feet, and its size (the side of its square). */
export type Spot = { x: number; y: number; s: number };
export type SceneLayout = { w: number; h: number; surfY: number; shaftW: number; digs: Spot[]; rests: Spot[]; fire: Spot };

const SHAFT = 28;
const GOLDEN = 2.39996;

/**
 * The scene on a `w` x `h` canvas: the surface (sky, grass) on top, the earth under it. Diggers stand in pockets of
 * the earth in a staggered grid, as big as they fit; resters sit around the campfire on the surface, spread in a
 * squashed spiral so they are not in rows. Everything lies inside the canvas and diggers' boxes never overlap.
 */
export function sceneLayout(dig: number, rest: number, w: number, h: number): SceneLayout {
  const share = rest / Math.max(1, dig + rest);
  const surfY = Math.round(h * (0.28 + 0.22 * share));

  // Diggers: the grid (columns) that gives them the biggest size.
  const x0 = SHAFT + 10;
  const gw = w - x0 - 10;
  const top = surfY + 34;
  const gh = h - 12 - top;
  let best = { cols: 1, size: 0 };
  for (let c = 1; c <= Math.max(1, dig); c++) {
    const rows = Math.ceil(dig / c);
    const size = Math.min(120, gw / (c + (rows > 1 ? 0.5 : 0)), gh / (rows * 1.05));
    if (size > best.size + 1e-9) best = { cols: c, size };
  }
  const rows = Math.ceil(dig / best.cols);
  const size = Math.max(10, Math.floor(best.size));
  const cellH = gh / Math.max(1, rows);
  const digs: Spot[] = Array.from({ length: dig }, (_, i) => {
    const col = i % best.cols;
    const row = Math.floor(i / best.cols);
    const slack = Math.max(0, cellH - size * 1.05);
    const jitter = (((i * 7) % 5) - 2) / 2 * slack * 0.5;
    const stagger = rows > 1 && row % 2 ? 0.5 : 0;
    return { x: x0 + size * (col + 0.5 + stagger) + (gw - size * (best.cols + (rows > 1 ? 0.5 : 0))) / 2, y: top + cellH * (row + 0.5) + size * 0.5 + jitter, s: size };
  });

  // Resters: a squashed phyllotaxis spiral around the fire, the biggest size at which all fit on the surface.
  const fx = w / 2;
  let rests: Spot[] = [];
  let fire: Spot = { x: fx, y: surfY - 10, s: 40 };
  for (let s = 110; s >= 16; s -= 2) {
    const fy = (s + 8 + surfY + 8) / 2;
    const c = 0.8 * s;
    const pts: Spot[] = [];
    for (let i = 0; pts.length < rest && i < rest * 6 + 12; i++) {
      const r = c * Math.sqrt(i + 3);
      const x = fx + r * Math.cos(i * GOLDEN);
      const y = fy + r * Math.sin(i * GOLDEN) * 0.32;
      if (Math.abs(x - fx) < 0.8 * s && y < fy + 0.6 * s && y > fy - 0.6 * s) continue; // that's the fire
      pts.push({ x, y, s });
    }
    const fits = pts.every((p) => p.x >= s / 2 + 4 && p.x <= w - s / 2 - 4 && p.y >= s + 8 && p.y <= surfY + 8);
    fire = { x: fx, y: fy, s };
    rests = pts;
    if (fits || s <= 16) break;
  }
  return { w, h, surfY, shaftW: SHAFT, digs, rests, fire };
}
