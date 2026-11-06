import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, ROLES, type Agent } from "../lib/api";
import { useLiveConnection, useServerEvents, type ServerEvent } from "../lib/events";
import { diffEvents, groupLook, kindOf, keyOf, pickHall, phaseOf, progress, PHASE_NAMES, type Overview, type RunningDelivery } from "../lib/workers";
import { LH, LW, drawOverlay, makeWorld, pick, pushEvent, render, setFinished, setHall, stateLabel, step, syncAgents, taskLine, type HallView, type Worker, type World } from "../lib/settlement";

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
          hat: look.hat, shirt: look.shirt, straw: look.straw, initials: look.initials,
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
  const scale = useRef(1);
  const prevOv = useRef<Overview | null>(null);
  const hallKey = useRef<string | null>(null);

  useEffect(() => { syncAgents(world.current, workers); }, [workers]);
  useEffect(() => {
    if (!ov) return;
    setFinished(world.current, ov.merged.map((m) => ({ key: keyOf(m), title: m.title, spec: m.spec })));
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
    const off = document.createElement("canvas");
    off.width = LW; off.height = LH;
    const oc = off.getContext("2d")!;
    const resize = () => {
      const W = box.clientWidth, H = Math.round((W * LH) / LW), dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      scale.current = W / LW; world.current.viewW = W;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    let raf = 0, last = performance.now(), uiT = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = world.current, k = scale.current;
      step(w, dt);
      render(oc, w);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, LW * k, LH * k);
      ctx.drawImage(off, 0, 0, LW * k, LH * k);
      drawOverlay(ctx, w, k);
      const sa = w.agents.find((a) => a.id === w.selected);
      if (bubbleRef.current) {
        bubbleRef.current.style.display = sa ? "block" : "none";
        if (sa) bubbleRef.current.style.transform = `translate(${Math.min(Math.max(sa.x * k, 90), w.viewW - 90)}px, ${(sa.y - (sa.carry ? 22 : sa.need ? 34 : 16)) * k}px) translate(-50%, -100%)`;
      }
      uiT -= dt;
      if (uiT <= 0) {
        uiT = 0.2;
        const ag = w.agents;
        const needy = ag.find((a) => a.need);
        setUi({
          building: ag.filter((a) => ["DISPATCHING", "GATHERING", "HAULING", "PLANNING"].includes(a.state)).length,
          inspecting: ag.filter((a) => a.state === "INSPECTING" || a.state === "STANDBY").length,
          resting: ag.filter((a) => a.state === "RESTING" || a.state === "RETURNING_TO_CAMP").length,
          need: needy ? needy.name : null,
          celebrate: w.hall.celebrate > 0 ? w.hall.celebrating : null,
          sel: sa ? { id: sa.id, name: sa.name, role: sa.roleLabel, group: sa.group, task: taskLine(sa, w), state: stateLabel(sa.state) } : null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const toWorld = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect(), k = scale.current;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k] as const;
  };
  const onClick = (e: React.MouseEvent) => {
    const w = world.current, id = pick(w, ...toWorld(e));
    w.selected = id === w.selected ? null : id;
  };
  const onMove = (e: React.MouseEvent) => {
    const w = world.current;
    w.hover = pick(w, ...toWorld(e));
    canvasRef.current!.style.cursor = w.hover !== null ? "pointer" : "default";
  };

  /* ---- the dock ---- */
  const pct = view ? Math.round(view.pct) : 0;
  const ph = phaseOf(view?.pct ?? 0);
  let status: string, tone: string;
  if (ui.need) { status = `[⚑ WAITING FOR YOU] ${ui.need.toUpperCase()} NEEDS AN ANSWER`; tone = "text-[#ffc46b] glow-amber"; }
  else if (ui.celebrate) { status = `[★ RELEASING] ${(view?.title ?? "SPEC").toUpperCase()} COMPLETE • SPEC MERGED • RAISING THE BANNER`; tone = "text-[#ffe066] glow-gold"; }
  else if (ui.building + ui.inspecting > 0) { status = `[🔨 WORKING] ${ui.building} BUILDING • ${ui.inspecting} INSPECTING • ${ui.resting} RESTING`; tone = "text-[#9cff7a] glow-green"; }
  else { status = "[☕ RESTING] EVERYONE IS AT THE CAMP"; tone = "text-[#9fc6ff] glow-blue"; }
  const btn = (on: boolean, label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-pressed={on} className={`px-3 py-1 text-[15px] leading-none tracking-wide border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe58a] ${on ? "bg-[#ffd36b] border-[#7a3d18] text-[#3a2414] shadow-[inset_0_-3px_0_#d9a43c]" : "bg-[#c99a62] border-[#5a3519] text-[#3a2414] hover:bg-[#dcae74] shadow-[inset_0_-3px_0_#a47444]"}`}>
      {label}
    </button>
  );

  return (
    <div className="h-full overflow-y-auto bg-[#1d130c] px-3 py-4 sm:px-4">
      <div className="mx-auto max-w-[1280px]">
        <div className="border-4 border-[#3a2414] bg-[#3a2414] p-1 shadow-[0_18px_50px_-18px_rgba(0,0,0,.8)]">
          <div ref={boxRef} className="relative w-full">
            <canvas ref={canvasRef} onClick={onClick} onMouseMove={onMove} onMouseLeave={() => { world.current.hover = null; }} className="block" style={{ imageRendering: "pixelated" }}
              role="img" aria-label="Pixel settlement: agents gather from the backlog, haul materials and build the running spec's hall; idle agents rest at the homestead" />
            <div ref={bubbleRef} className="pixel pointer-events-auto absolute left-0 top-0 hidden max-w-[220px] border-[3px] border-[#2a1a10] bg-[#f3e2b8] px-2.5 py-1.5 text-[13px] leading-snug text-[#3a2414]">
              {ui.sel && (
                <>
                  <div className="text-[#7a3d18]">{ui.sel.name} · {ui.sel.role}</div>
                  <div>{ui.sel.task}</div>
                  <div className="text-[12px] uppercase text-[#7a3d18]">{ui.sel.state}{ui.sel.group ? ` · ${ui.sel.group}` : ""}</div>
                  <Link to={`/agents/${ui.sel.id}`} className="mt-1 inline-block border-2 border-[#5a3519] bg-[#ffd36b] px-2 py-0.5 text-[13px] text-[#3a2414] hover:bg-[#ffe58a]">Open chat →</Link>
                </>
              )}
            </div>
          </div>
          <div className="wood mt-1 space-y-2 p-2.5">
            <div className="parchment pixel border-2 border-[#5a3519] px-3 py-1.5 text-[#3a2414]">
              {view ? (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[15px]">
                    <span>🏗️ {view.title}: <b>{view.done}</b> / {view.total} tickets</span>
                    <span className="text-[13px] text-[#7a3d18]">Phase {ph}/5 · {PHASE_NAMES[ph]} · spec #{view.spec}{view.pr ? ` · PR #${view.pr}` : ""}</span>
                  </div>
                  <div className="mt-1 h-3.5 border-2 border-[#3a2414] bg-[#5a3519]"><div className="bar h-full bg-[#7fd05a] transition-[width] duration-500" style={{ width: `${pct}%` }} /></div>
                </>
              ) : (
                <div className="text-[15px]">🏗️ Waiting for a spec: no Delivery is running.</div>
              )}
            </div>
            <div className="border-2 border-[#1c0f07] bg-[#1f130b] px-3 py-2 shadow-[inset_0_2px_6px_rgba(0,0,0,.7)]">
              <div className="overflow-hidden whitespace-nowrap">
                <div className={`marquee pixel inline-flex gap-20 text-[17px] tracking-wider ${tone}`}>
                  <span>{status}</span><span aria-hidden="true">{status}</span><span aria-hidden="true">{status}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {demoOn && (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="pixel mr-1 text-[14px] text-[#ffe9b8]">SHIFT</span>
                    {btn(demo.on === true, "Deploy", () => setDemo((d) => ({ ...d, on: true })))}
                    {btn(demo.on === false, "Recall", () => setDemo((d) => ({ ...d, on: false })))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="pixel mr-1 text-[14px] text-[#ffe9b8]">SPEED</span>
                    {[[1, "1x"], [2, "2x"], [6, "Turbo"]].map(([v, l]) => <span key={l}>{btn(demo.speed === v, String(l), () => setDemo((d) => ({ ...d, speed: Number(v) })))}</span>)}
                  </div>
                  {btn(false, "Simulate PR Merge", () => setDemo((d) => ({ ...d, ov: simulateMerge(d.ov) })))}
                </>
              )}
              <div className="parchment pixel ml-auto flex flex-wrap gap-x-4 border-2 border-[#5a3519] px-3 py-1 text-[15px] tabular-nums text-[#3a2414]">
                <span>Building: <b className="text-[#2f7a35]">{ui.building}</b></span>
                <span>Inspecting: <b className="text-[#3d6fb3]">{ui.inspecting}</b></span>
                <span>Resting: <b className="text-[#a3412b]">{ui.resting}</b></span>
                <span>Finished: <b>{ov?.merged.length ?? 0}</b></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
