/** The Workers page's pure parts: an agent's worker state and look, the Delivery's hall and its events. */

export type WorkerState = "working" | "resting";

/** Working while the agent runs a run, resting otherwise. */
export function workerState(agent: { status: string }): WorkerState {
  return agent.status === "running" ? "working" : "resting";
}

/** What a worker does at the settlement: Devs (and Custom agents) haul, checkers inspect, a Lead walks the site. */
export type Kind = "dev" | "qa" | "security" | "reviewer" | "lead";
export function kindOf(role?: string): Kind {
  return role === "lead" ? "lead" : role === "qa" ? "qa" : role === "security" ? "security" : role === "code_reviewer" ? "reviewer" : "dev";
}

/** Hat colors that read well on the colony's dusk sky and earth. */
export const HAT_COLORS = ["#d9463b", "#e8a33b", "#4a7fd6", "#3cae76", "#c25b9e", "#2f9a8a", "#7b4bb0", "#e0703a"];
const SHIRTS = ["#3f7fd0", "#c4473c", "#2f9a8a", "#7b4bb0", "#e0a53a", "#8a5a30", "#3cae76", "#c25b9e"];
/** Agents with no group share this look. */
export const NEUTRAL = { hat: "#9a9cad", shirt: "#8d8a97" };

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

/** The look of a worker from its agent's group label (a group is only a label): hat, shirt and initials. No group: neutral. */
export function groupLook(agent: { group?: string }): { hat: string; shirt: string; initials: string } {
  const label = agent.group?.trim() ?? "";
  if (!label) return { ...NEUTRAL, initials: "" };
  const h = hash(label.toLowerCase());
  const hat = h % HAT_COLORS.length;
  return { hat: HAT_COLORS[hat], shirt: SHIRTS[(h >>> 8) % SHIRTS.length === hat ? ((h >>> 8) + 1) % SHIRTS.length : (h >>> 8) % SHIRTS.length], initials: initials(label) };
}

/* ---------- the hall: the spec of the most recently active running Delivery ---------- */

export type DeliveryTicket = { number: number; title: string; state: string; verdicts?: Record<string, string> };
export type RunningDelivery = { repo: string; spec: number; title: string; state: string; pr: number | null; dev: string; current: number | null; tickets: DeliveryTicket[] };
export type MergedSpec = { repo: string; spec: number; title: string };
/** Spec PRs found ready (or plans waiting for Merge) that aren't merged yet. */
export type Overview = { running: RunningDelivery[]; merged: MergedSpec[]; releasing?: { repo: string; spec: number }[] };

export const keyOf = (d: { repo: string; spec: number }) => `${d.repo}#${d.spec}`;

/** Tickets done out of the Delivery's tickets. */
export function progress(d: RunningDelivery): { done: number; total: number; pct: number } {
  const total = d.tickets.length;
  const done = d.tickets.filter((t) => t.state === "closed").length;
  return { done, total, pct: total ? (100 * done) / total : 0 };
}

/** The five phases of the building, by how much of the spec is done (the prototype's thresholds). */
export function phaseOf(pct: number): 1 | 2 | 3 | 4 | 5 {
  const p = pct / 100;
  return p >= 1 ? 5 : p > 0.75 ? 4 : p > 0.5 ? 3 : p > 0.25 ? 2 : 1;
}
export const PHASE_NAMES = ["", "Foundation & blueprints", "Stone base & scaffolding", "Timber framing", "Roof & finishing touches", "Complete"];

/** The hall: the running Delivery whose Dev is running now, else the newest running one (the list is newest first); none: an empty lot. */
export function pickHall(running: RunningDelivery[], agents: { id: string; status: string }[]): RunningDelivery | null {
  const busy = new Set(agents.filter((a) => a.status === "running").map((a) => a.id));
  return running.find((d) => busy.has(d.dev)) ?? running[0] ?? null;
}

export type HallEvent =
  | { type: "closed"; key: string; number: number }
  | { type: "review"; key: string; number: number }
  | { type: "merged"; key: string; spec: number; title: string };

/** What changed between two overviews: tickets that closed, tickets that went into review, specs that merged. Nothing on the first one. */
export function diffEvents(prev: Overview | null, next: Overview): HallEvent[] {
  if (!prev) return [];
  const out: HallEvent[] = [];
  for (const d of prev.running) {
    const key = keyOf(d);
    const now = next.running.find((n) => keyOf(n) === key);
    if (!now) {
      const m = next.merged.find((m) => keyOf(m) === key);
      if (m) out.push({ type: "merged", key, spec: m.spec, title: m.title });
      continue;
    }
    for (const t of now.tickets) {
      const was = d.tickets.find((p) => p.number === t.number)?.state;
      if (was === t.state) continue;
      if (t.state === "closed") out.push({ type: "closed", key, number: t.number });
      else if (t.state === "review") out.push({ type: "review", key, number: t.number });
    }
  }
  return out;
}

/* ---------- the caption: one answer for the page's dock and the navigation button ---------- */

export type Caption = "Waiting for you" | "Releasing" | "Working" | "Resting";

/** What the team is doing, in priority order: a Needs you item is open, a spec PR is being released (marked ready or merged), any agent runs, else resting. */
export function caption(s: { needsYou: boolean; releasing: boolean; working: boolean }): Caption {
  return s.needsYou ? "Waiting for you" : s.releasing ? "Releasing" : s.working ? "Working" : "Resting";
}

/** The ids of the agents with an open Needs you item: their workers hold the sign. Items about no agent name nobody. */
export function needyAgents(items: { agent: { id: string } | null }[]): Set<string> {
  return new Set(items.flatMap((i) => (i.agent ? [i.agent.id] : [])));
}

/** Is a spec PR being released: found ready and not merged yet, or its merge is being celebrated now. */
export function isReleasing(ov: Overview | null, celebrating: boolean): boolean {
  return celebrating || !!ov?.releasing?.length;
}
