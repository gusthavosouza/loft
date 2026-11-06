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

/** The look of a worker from its agent's group label (else its main project): hat color and T-shirt initials. */
export function groupLook(agent: { group?: string; project?: string }): { hat: string; initials: string } {
  const label = agent.group?.trim() || agent.project?.trim() || ""; // its team, as `teamOf` in team.ts (not imported: tests run this file bare)
  if (!label) return { hat: NEUTRAL_HAT, initials: "" };
  return { hat: HAT_COLORS[hash(label.toLowerCase()) % HAT_COLORS.length], initials: initials(label) };
}

/** Smallest and largest side of a worker's cell, in px. */
export const MIN_CELL = 52;
export const MAX_CELL = 104;

/** Workers in a panel `width` px wide: columns, rows and the cell side, so that `count` of them fit without sideways overflow. */
export function layout(count: number, width: number): { cols: number; rows: number; cell: number } {
  if (count <= 0 || width <= 0) return { cols: 0, rows: 0, cell: 0 };
  const cols = Math.max(1, Math.min(count, Math.floor(width / MIN_CELL)));
  const cell = Math.min(MAX_CELL, Math.floor(width / cols));
  return { cols, rows: Math.ceil(count / cols), cell };
}
