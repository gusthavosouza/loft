import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Agent } from "../lib/api";
import { useLiveConnection, useServerEvents, type ServerEvent } from "../lib/events";
import { sceneLayout, workerState } from "../lib/workers";
import { WorkersScene } from "../components/WorkersScene";

/** The canvas is 1000 wide on a desktop, 400 on a phone (fewer, bigger props); its height follows the page's shape. */
const canvas = (px: { w: number; h: number }) => {
  const w = px.w < 640 ? 400 : 1000;
  return { w, h: Math.max(300, Math.round((w * px.h) / Math.max(1, px.w))) };
};

/** Workers: one scene, one worker per agent: digging underground while its agent runs, resting at the campfire otherwise. Live. */
export default function WorkersPage() {
  const live = useLiveConnection();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const fresh = useRef(new Map<string, Agent | null>());
  useEffect(() => {
    fresh.current.clear(); // loads on mount and again on each reconnect, as events sent while offline are lost
    api.agents().then((as) => setAgents(as.filter((a) => !fresh.current.has(a.id)).concat([...fresh.current.values()].filter((a): a is Agent => !!a)))).catch(() => setAgents((as) => as ?? []));
  }, [live]);
  useServerEvents(
    useCallback((e: ServerEvent) => {
      if (e.type === "agent_updated") {
        fresh.current.set(e.agent.id, e.agent);
        setAgents((as) => (as ? (as.some((a) => a.id === e.agent.id) ? as.map((a) => (a.id === e.agent.id ? { ...a, ...e.agent } : a)) : [...as, e.agent]) : as));
      } else if (e.type === "agent_deleted") {
        fresh.current.set(e.agent_id, null);
        setAgents((as) => as && as.filter((a) => a.id !== e.agent_id));
      }
    }, []),
  );

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 560 });
  const loaded = agents !== null;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  if (agents === null) return <div className="p-6 font-mono text-xs text-fg-3">Loading…</div>;
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const digs = sorted.filter((a) => workerState(a) === "digging");
  const rests = sorted.filter((a) => workerState(a) === "resting");
  const c = canvas(size);
  return (
    <div ref={box} className="relative h-full w-full overflow-hidden bg-[#1d1f4a]">
      <WorkersScene layout={sceneLayout(digs.length, rests.length, c.w, c.h)} digs={digs} rests={rests} reduced={reduced} />
      {!agents.length && <p className="absolute inset-x-0 top-6 text-center font-mono text-xs text-white/80">No agents yet. Create one and its worker shows up here.</p>}
    </div>
  );
}
