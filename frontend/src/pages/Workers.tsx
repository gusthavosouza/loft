import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, ROLES, type Agent } from "../lib/api";
import { useLiveConnection, useServerEvents, type ServerEvent } from "../lib/events";
import { diffEvents, groupLook, kindOf, keyOf, pickHall, phaseOf, progress, PHASE_NAMES, type Overview, type RunningDelivery } from "../lib/workers";
import { geometry, makeWorld, pick, pushEvent, render, rescale, setFinished, setHall, stateLabel, step, syncAgents, taskLine, type Geo, type HallView, type Worker, type World } from "../lib/colony";

const reducedQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

/** Demo data for ?demo=1: a Delivery of ten tickets, three closed and one in review, and two merged specs. */
function demoDelivery(spec: number): RunningDelivery {
  const states = ["closed", "closed", "closed", "review", "open", "open", "open", "open", "open", "open"];
  return { repo: "demo", spec, title: "Workers live view", state: "running", pr: 84, dev: "", current: 4, tickets: states.map((state, i) => ({ number: 80 + i, title: `Ticket ${i + 1}`, state })) };
}
const DEMO_OVERVIEW: Overview = { running: [demoDelivery(83)], merged: [{ repo: "demo", spec: 54, title: "Projects are real repos" }, { repo: "demo", spec: 26, title: "Push portal" }] };

/** One more ticket of the demo Delivery done (the next goes into review); after the last, the spec merges. */
function simulateMerge(ov: Overview): Overview {
  const d = ov.running[0];
  if (!d) return { running: [{ ...demoDelivery(ov.merged[0].spec + 1), tickets: demoDelivery(0).tickets.map((t, i) => ({ ...t, state: i === 0 ? "review" : "open" })) }], merged: ov.merged };
  const i = d.tickets.findIndex((t) => t.state !== "closed");
  if (i < 0) return { running: [], merged: [{ repo: d.repo, spec: d.spec, title: d.title }, ...ov.merged].slice(0, 5) };
  const tickets = d.tickets.map((t, j) => (j === i ? { ...t, state: "closed" } : j === i + 1 ? { ...t, state: "review" } : t));
  return { ...ov, running: [{ ...d, tickets }] };
}

type Ui = { building: number; inspecting: number; resting: number; need: string | null; celebrate: string | null; sel: { id: string; name: string; role: string; group: string; task: string; state: string } | null };
const NO_UI: Ui = { building: 0, inspecting: 0, resting: 0, need: null, celebrate: null, sel: null };

/** The dock's numbers, counted from the colony's agents by what they are doing now. */
function snapshot(w: World): Ui {
  const ag = w.agents, needy = ag.find((a) => a.need), sa = ag.find((a) => a.id === w.selected);
  return {
    building: ag.filter((a) => ["DISPATCHING", "WORKING", "HAULING", "PLANNING"].includes(a.state)).length,
    inspecting: ag.filter((a) => a.state === "INSPECTING" || a.state === "STANDBY").length,
    resting: ag.filter((a) => a.state === "RESTING" || a.state === "RETURNING_TO_CAMP").length,
    need: needy ? needy.name : null,
    celebrate: w.hall.celebrate > 0 ? w.hall.celebrating : null,
    sel: sa ? { id: sa.id, name: sa.name, role: sa.roleLabel, group: sa.group, task: taskLine(sa, w), state: stateLabel(sa.state) } : null,
  };
}

/** Workers: a pixel settlement. Each agent is a worker; the running Delivery's spec is the hall they build, PR by PR. */
export default function WorkersPage() {
  const demoOn = useSearchParams()[0].get("demo") === "1";
  const live = useLiveConnection();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [needs, setNeeds] = useState<Set<string>>(new Set());
  const [real, setReal] = useState<Overview | null>(null);
  const [demo, setDemo] = useState<{ on: boolean | null; ov: Overview; speed: number }>({ on: null, ov: DEMO_OVERVIEW, speed: 1 });
  const [reduced, setReduced] = useState(() => reducedQuery().matches);
  const [ui, setUi] = useState<Ui>(NO_UI);

  const fresh = useRef(new Map<string, Agent | null>());
  const loadOverview = useCallback(() => { api.workersOverview().then(setReal).catch(() => {}); }, []);
  useEffect(() => {
    fresh.current.clear(); // loads on mount and again on each reconnect, as events sent while offline are lost
    api.agents().then((as) => setAgents(as.filter((a) => !fresh.current.has(a.id)).concat([...fresh.current.values()].filter((a): a is Agent => !!a)))).catch(() => {});
    loadOverview();
  }, [live, loadOverview]);
  useEffect(() => {
    const read = () => api.needsYou().then((r) => setNeeds(new Set(r.items.flatMap((i) => (i.agent ? [i.agent.id] : []))))).catch(() => {});
    read();
    const t = setInterval(() => { read(); loadOverview(); }, 15000);
    return () => clearInterval(t);
  }, [loadOverview]);
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents(
    useCallback((e: ServerEvent) => {
      if (e.type === "agent_updated") {
        fresh.current.set(e.agent.id, e.agent);
        setAgents((as) => (as.some((a) => a.id === e.agent.id) ? as.map((a) => (a.id === e.agent.id ? { ...a, ...e.agent } : a)) : [...as, e.agent]));
      } else if (e.type === "agent_deleted") {
        fresh.current.set(e.agent_id, null);
        setAgents((as) => as.filter((a) => a.id !== e.agent_id));
      }
      // Deliveries move with tickets and pull requests: one read soon after the last such event.
      if (e.type === "task" || e.type === "pull_request" || e.type === "agent_updated") {
        clearTimeout(reload.current);
        reload.current = setTimeout(loadOverview, 1500);
      }
    }, [loadOverview]),
  );
  useEffect(() => {
    const m = reducedQuery();
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const ov = demoOn ? demo.ov : real;
  const sorted = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  const hall = useMemo(() => (ov ? pickHall(ov.running, sorted) : null), [ov, sorted]);
  const view: HallView | null = useMemo(() => {
    if (!hall) return null;
    const p = progress(hall);
    return { key: keyOf(hall), title: hall.title, spec: hall.spec, pr: hall.pr, done: p.done, total: p.total, pct: p.pct };
  }, [hall]);
  const workers: Worker[] = useMemo(
    () =>
      sorted.map((a) => {
        const look = groupLook(a);
        const cur = hall && hall.dev === a.id ? hall.tickets.find((t) => t.number === hall.current) : undefined;
        return {
          id: a.id, name: a.name, kind: kindOf(a.role), roleLabel: ROLES.find((r) => r.value === a.role)?.label ?? "Agent", group: a.group?.trim() ?? "",
          hat: look.hat, shirt: look.shirt, initials: look.initials,
          on: demoOn && demo.on !== null ? demo.on : a.status === "running", need: needs.has(a.id), status: a.status_text, ticket: cur ? { number: cur.number, title: cur.title } : null,
        };
      }),
    [sorted, hall, needs, demoOn, demo.on],
  );

  /* ---- the settlement ---- */
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const world = useRef<World>(null as unknown as World);
  if (!world.current) world.current = makeWorld();
  const geo = useRef<Geo>(null as unknown as Geo);
  const workersRef = useRef<Worker[]>([]);
  workersRef.current = workers;
  const prevOv = useRef<Overview | null>(null);
  const hallKey = useRef<string | null>(null);

  useEffect(() => {
    if (!geo.current) return;
    syncAgents(world.current, geo.current, workers);
    setUi(snapshot(world.current));
  }, [workers]);
  useEffect(() => {
    if (!ov) return;
    setFinished(world.current, ov.merged.slice(0, 5).map((m) => ({ key: keyOf(m), title: m.title, spec: m.spec })));
    for (const e of diffEvents(prevOv.current, ov)) if (e.key === hallKey.current) pushEvent(world.current, e);
    prevOv.current = ov;
    hallKey.current = view?.key ?? null;
  }, [ov, view]);
  // after the events above: a merge must start its party before the hall is swapped
  useEffect(() => { setHall(world.current, view); }, [view]);
  useEffect(() => {
    const w = world.current;
    w.reduced = reduced;
    w.speed = (reduced ? 0.4 : 1) * (demoOn ? demo.speed : 1);
  }, [reduced, demoOn, demo.speed]);

  useEffect(() => {
    const canvas = canvasRef.current!, box = boxRef.current!, ctx = canvas.getContext("2d")!;
    const resize = () => {
      const W = box.clientWidth, H = Math.round(Math.min(560, Math.max(330, W * 0.46))), dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const old = geo.current;
      geo.current = geometry(W, H);
      if (old) rescale(world.current, geo.current, W / old.W);
      else syncAgents(world.current, geo.current, workersRef.current);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    let raf = 0, last = performance.now(), uiT = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = world.current, g = geo.current;
      step(w, g, dt);
      render(ctx, g, w);
      const sa = w.agents.find((a) => a.id === w.selected);
      if (bubbleRef.current) {
        bubbleRef.current.style.display = sa ? "block" : "none";
        if (sa) {
          // above the worker's name tag, or below the worker when there is no room above it
          const above = (sa.labelTop ?? sa.y - 46 * g.s) - 18, h = bubbleRef.current.offsetHeight;
          const top = above - h < 8 ? Math.min(sa.y + 10, g.H - h - 8) : above - h;
          bubbleRef.current.style.transform = `translate(${Math.min(Math.max(sa.x, 110), g.W - 110)}px, ${Math.max(8, top)}px) translate(-50%, 0)`;
        }
      }
      uiT -= dt;
      if (uiT <= 0) {
        uiT = 0.2;
        setUi(snapshot(w));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const local = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const onClick = (e: React.MouseEvent) => {
    const w = world.current, id = pick(w, geo.current, ...local(e));
    w.selected = id === w.selected ? null : id;
  };
  const onMove = (e: React.MouseEvent) => {
    const w = world.current, [x, y] = local(e);
    w.hover = pick(w, geo.current, x, y);
    w.parTarget = x / geo.current.W;
    canvasRef.current!.style.cursor = w.hover !== null ? "pointer" : "default";
  };
  const onLeave = () => { world.current.hover = null; world.current.parTarget = 0.5; };

  /* ---- the dock ---- */
  const pct = view ? Math.round(view.pct) : 0;
  const ph = phaseOf(view?.pct ?? 0);
  let status: string, tone: string, glow: string;
  if (ui.need) { status = `⚑ WAITING FOR YOU — ${ui.need.toUpperCase()} NEEDS AN ANSWER`; tone = "text-[#ffb547]"; glow = "0 0 14px rgba(255,181,71,.55)"; }
  else if (ui.celebrate) { status = `★ RELEASING — ${(view?.title ?? "SPEC").toUpperCase()} COMPLETE · SPEC MERGED`; tone = "text-[#ffe066]"; glow = "0 0 16px rgba(255,224,102,.6)"; }
  else if (ui.building + ui.inspecting > 0) { status = `● WORKING — ${ui.building} AGENTS BUILDING${view ? ` ${view.title.toUpperCase()}` : ""} · ${ui.inspecting} INSPECTING · ${ui.resting} RESTING`; tone = "text-[#5ef08a]"; glow = "0 0 14px rgba(94,240,138,.55)"; }
  else { status = `◑ RESTING — ${ui.resting} AGENTS AT CAMP${view ? "" : " · NO DELIVERY RUNNING"}`; tone = "text-[#9fc6ff]"; glow = "0 0 12px rgba(159,198,255,.45)"; }
  const btn = (on: boolean, label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-pressed={on} className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold tracking-wide transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ffd27a] ${on ? "bg-[#ffd27a] text-[#1d1424]" : "bg-white/10 text-[#efe6d8] hover:bg-white/20"}`}>{label}</button>
  );

  return (
    <div className="h-full overflow-y-auto bg-[#0f0d1d] px-3 py-4 sm:px-4">
      <div className="mx-auto max-w-[1280px] overflow-hidden rounded-2xl border border-white/10 bg-[#151a36] shadow-[0_20px_60px_-20px_rgba(0,0,0,.7)]">
        <div ref={boxRef} className="relative w-full">
          <canvas ref={canvasRef} onClick={onClick} onMouseMove={onMove} onMouseLeave={onLeave} className="block"
            role="img" aria-label="Animated colony: agents dig at the quarry, haul materials to build the running spec's hall, and rest at camp" />
          <div ref={bubbleRef} className="pointer-events-auto absolute left-0 top-0 hidden w-[220px] rounded-xl border-[1.5px] border-[#1a1424] bg-[#fbf6ec] px-3 py-2 text-[12px] leading-snug text-[#231a2b]">
            {ui.sel && (
              <>
                <div className="font-bold">{ui.sel.name} · {ui.sel.role}</div>
                <div className="text-[10px] font-bold uppercase tracking-wide text-[#18794e]">{ui.sel.state}{ui.sel.group ? ` · ${ui.sel.group}` : ""}</div>
                <div className="mt-0.5 font-mono">{ui.sel.task}</div>
                <Link to={`/agents/${ui.sel.id}`} className="mt-1.5 inline-block rounded-full bg-[#231a2b] px-2.5 py-0.5 text-[11px] font-semibold text-[#fbf6ec] hover:bg-[#3a2c4a]">Open chat →</Link>
              </>
            )}
          </div>
        </div>
        <div className="space-y-2.5 border-t border-white/10 bg-[rgba(18,14,32,0.85)] p-3 backdrop-blur-md">
          <div>
            {view ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
                  <span className="font-semibold text-[#f6ead7]">🏗️ {view.title}: <span className="font-mono tabular-nums">{view.done} / {view.total} tickets</span></span>
                  <span className="font-mono text-[12px] text-[#b9adc9]">phase {ph}/5 · {PHASE_NAMES[ph]} · spec #{view.spec}{view.pr ? ` · PR #${view.pr}` : ""}</span>
                </div>
                <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-[#ffb547] to-[#ffe066] transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
              </>
            ) : (
              <div className="text-[13px] font-semibold text-[#f6ead7]">🏗️ Waiting for a spec <span className="font-normal text-[#b9adc9]">· no Delivery is running</span></div>
            )}
          </div>
          <div className="overflow-hidden whitespace-nowrap border-y border-white/10 py-2">
            <div className={`marquee inline-flex gap-16 font-mono text-[12.5px] font-semibold tracking-[0.08em] ${tone}`} style={{ textShadow: glow }}>
              <span>{status}</span><span aria-hidden="true">{status}</span><span aria-hidden="true">{status}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {demoOn && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {btn(demo.on === false, "Call All to Camp", () => setDemo((d) => ({ ...d, on: false })))}
                  {btn(demo.on === true, "Deploy All to Work", () => setDemo((d) => ({ ...d, on: true })))}
                  {btn(demo.on === null, "Real status", () => setDemo((d) => ({ ...d, on: null })))}
                  {btn(false, "Simulate PR Merge", () => setDemo((d) => ({ ...d, ov: simulateMerge(d.ov) })))}
                </div>
                <label htmlFor="workers-speed" className="flex items-center gap-2 text-[12px] text-[#d9cfe6]">
                  Speed
                  <input id="workers-speed" type="range" min="0.25" max="4" step="0.05" value={demo.speed} onChange={(e) => setDemo((d) => ({ ...d, speed: parseFloat(e.target.value) }))} className="w-28 accent-[#ffd27a]" />
                  <span className="w-10 font-mono tabular-nums text-[#f6ead7]">×{demo.speed.toFixed(2)}</span>
                </label>
              </>
            )}
            <div className="ml-auto font-mono text-[12.5px] tabular-nums text-[#f6ead7]">
              [ 🔨 Building: <b className="text-[#5ef08a]">{ui.building}</b> | 🔍 Inspecting: <b className="text-[#9fc6ff]">{ui.inspecting}</b> | ⛺ Resting: <b className="text-[#ffb547]">{ui.resting}</b> | 🏠 Finished: <b>{Math.min(5, ov?.merged.length ?? 0)}</b> ]
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
