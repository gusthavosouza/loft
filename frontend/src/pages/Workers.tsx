import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, type Agent } from "../lib/api";
import { useLiveConnection, useServerEvents, type ServerEvent } from "../lib/events";
import { groupLook, layout, workerState, type WorkerState } from "../lib/workers";

/** One chubby worker on a 100x100 canvas: a hat in its group's color, a T-shirt with the group's initials. */
function Worker({ agent, state, size }: { agent: Agent; state: WorkerState; size: number }) {
  const { hat, initials } = groupLook(agent);
  const digging = state === "digging";
  return (
    <Link to={`/agents/${agent.id}`} title={`${agent.name}: ${digging ? "digging" : "resting"}`} aria-label={`${agent.name}, ${digging ? "digging" : "resting"}`} className="flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} className={digging ? "worker worker-dig" : "worker worker-rest"}>
        <ellipse cx="50" cy="94" rx="26" ry="5" fill="#000" opacity="0.25" />
        <g className="worker-body">
          <rect x="24" y="52" width="52" height="38" rx="18" fill="#f4f1ea" />
          <text x="50" y="77" textAnchor="middle" fontSize="17" fontWeight="700" fontFamily="ui-sans-serif, system-ui" fill="#17171c">{initials}</text>
          <circle cx="50" cy="38" r="22" fill="#f2c9a0" />
          <ellipse cx="42" cy="38" rx="3.2" ry="4" fill="#17171c" />
          <ellipse cx="58" cy="38" rx="3.2" ry="4" fill="#17171c" />
          <path d={digging ? "M43 48 Q50 52 57 48" : "M44 47 Q50 52 56 47"} stroke="#17171c" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          <path d="M26 30 C26 8 74 8 74 30 Z" fill={hat} />
          <rect x="22" y="28" width="56" height="6" rx="3" fill={hat} />
          <rect x="22" y="31" width="56" height="3" rx="1.5" fill="#000" opacity="0.18" />
          {digging && (
            <g className="worker-pick">
              <rect x="76" y="40" width="4" height="34" rx="2" fill="#a8743c" />
              <path d="M62 42 Q78 30 94 42 Q78 36 62 42 Z" fill="#c9ced6" />
              <circle cx="74" cy="66" r="6" fill="#f2c9a0" />
            </g>
          )}
        </g>
        {digging && <circle className="worker-gold" cx="22" cy="86" r="4" fill="#f2b632" />}
      </svg>
    </Link>
  );
}

/** A tunnel cut into rock, with gold in its walls. */
function Tunnel({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Tunnel" className="rounded-3xl border border-line-strong bg-[#2a1f17] p-3">
      <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-fg-3">
        <span className="size-2 rounded-full bg-[#f2b632]" /> Digging
      </h2>
      {children}
    </section>
  );
}

/** A campfire with a ring of stones. */
function Campfire({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Campfire" className="rounded-3xl border border-line-strong bg-[#14202a] p-3">
      <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-fg-3">
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
          <path className="fire" d="M12 2 C14 7 18 9 18 14 A6 6 0 0 1 6 14 C6 11 8 10 9 7 C10 9 11 9 12 2 Z" fill="#f2955f" />
          <path className="fire" d="M12 11 C13 13 15 14 15 16 A3 3 0 0 1 9 16 C9 14 11 13 12 11 Z" fill="#f2c46d" />
        </svg>
        Resting
      </h2>
      {children}
    </section>
  );
}

/** The workers of one panel, their cells sized to the width of this very box (so padding around it never counts). */
function Crowd({ agents, state }: { agents: Agent[]; state: WorkerState }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { cell } = layout(agents.length, width);
  return (
    <div ref={box} className="flex flex-wrap justify-center gap-y-1">
      {agents.map((a) => (
        <Worker key={a.id} agent={a} state={state} size={cell} />
      ))}
    </div>
  );
}

/** Workers: one worker per agent, digging while its agent runs and resting by the campfire otherwise. Live. */
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

  if (agents === null) return <div className="p-6 font-mono text-xs text-fg-3">Loading…</div>;
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const digging = sorted.filter((a) => workerState(a) === "digging");
  const resting = sorted.filter((a) => workerState(a) === "resting");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4 max-sm:px-3">
        {!agents.length && <p className="p-6 text-center text-sm text-fg-3">No agents yet. Create one and its worker shows up here.</p>}
        {digging.length > 0 && (
          <Tunnel>
            <Crowd agents={digging} state="digging" />
          </Tunnel>
        )}
        {agents.length > 0 && (
          <Campfire>
            {resting.length ? <Crowd agents={resting} state="resting" /> : <p className="py-4 text-center text-xs text-fg-3">Everyone is at work.</p>}
          </Campfire>
        )}
      </div>
    </div>
  );
}
