import { memo, useMemo } from "react";
import { useNavigate } from "react-router";
import type { Agent } from "../lib/api";
import { groupLook, type SceneLayout, type Spot, type WorkerState } from "../lib/workers";

/** The Workers scene, all drawn here in SVG: sky and campfire on top, layers of earth under it, workers in tunnel pockets. */

const INK = "#1b1008";
const EARTH = ["#7a4d2c", "#6a4026", "#59341f", "#472818"];

/** A small seeded random, so the ground looks the same on every load and every resize of the same size. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A wavy line across the scene, as the top of a filled shape that runs down to the bottom. */
function wave(w: number, h: number, y: number, amp: number, phase: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= w + 20; x += 20) pts.push(`${x},${(y + amp * Math.sin((x / w) * 6.28 * 2 + phase) + amp * 0.5 * Math.sin((x / w) * 6.28 * 5 + phase * 2)).toFixed(1)}`);
  return `M${pts.join(" L")} L${w + 20},${h} L0,${h} Z`;
}

function Nugget({ x, y, r, twinkle }: { x: number; y: number; r: number; twinkle: number }) {
  const pts = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i / 6) * 6.283 + 0.4;
    const k = [1, 0.8, 1.05, 0.85, 1, 0.9][i];
    return `${(x + Math.cos(a) * r * k * 1.15).toFixed(1)},${(y + Math.sin(a) * r * k * 0.85).toFixed(1)}`;
  });
  return (
    <g>
      <polygon points={pts.join(" ")} fill="#f2b632" stroke="#7a4a05" strokeWidth={1.6} strokeLinejoin="round" />
      <path d={`M${x - r * 0.2},${y + r * 0.8} L${x + r * 1.1},${y + r * 0.3} L${x + r * 0.7},${y + r * 0.85} Z`} fill="#c98a10" opacity={0.7} />
      <ellipse cx={x - r * 0.35} cy={y - r * 0.3} rx={r * 0.4} ry={r * 0.22} fill="#fff4b0" opacity={0.9} />
      {twinkle > 0 && <path className="twinkle" style={{ animationDelay: `${twinkle}s`, transformOrigin: `${x + r}px ${y - r}px` }} d={`M${x + r},${y - r * 1.9} L${x + r * 1.2},${y - r} L${x + r},${y - r * 0.1} L${x + r * 0.8},${y - r} Z`} fill="#fffbe0" />}
    </g>
  );
}

function Rock({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <path d={`M${x - r},${y + r * 0.6} L${x - r * 0.7},${y - r * 0.5} L${x + r * 0.1},${y - r * 0.8} L${x + r},${y - r * 0.2} L${x + r * 0.9},${y + r * 0.6} Z`} fill="#8b9098" stroke="#2f3238" strokeWidth={1.6} strokeLinejoin="round" />
      <path d={`M${x - r * 0.6},${y - r * 0.3} L${x + r * 0.1},${y - r * 0.6} L${x - r * 0.1},${y - r * 0.1} Z`} fill="#c3c8cf" opacity={0.8} />
    </g>
  );
}

function Gem({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return (
    <g>
      <path d={`M${x},${y - r} L${x + r * 0.9},${y - r * 0.2} L${x},${y + r} L${x - r * 0.9},${y - r * 0.2} Z`} fill={color} stroke={INK} strokeWidth={1.5} strokeLinejoin="round" />
      <path d={`M${x - r * 0.9},${y - r * 0.2} L${x + r * 0.9},${y - r * 0.2} M${x},${y - r} L${x - r * 0.3},${y - r * 0.2} L${x},${y + r}`} stroke="#fff" strokeOpacity={0.55} strokeWidth={1} fill="none" />
    </g>
  );
}

function Bone({ x, y, r, rot }: { x: number; y: number; r: number; rot: number }) {
  return (
    <g transform={`rotate(${rot} ${x} ${y})`} fill="#eadfc4" stroke="#6b5b3a" strokeWidth={1.3}>
      <rect x={x - r} y={y - r * 0.22} width={r * 2} height={r * 0.44} rx={r * 0.2} />
      <circle cx={x - r} cy={y - r * 0.28} r={r * 0.3} />
      <circle cx={x - r} cy={y + r * 0.28} r={r * 0.3} />
      <circle cx={x + r} cy={y - r * 0.28} r={r * 0.3} />
      <circle cx={x + r} cy={y + r * 0.28} r={r * 0.3} />
    </g>
  );
}

/** Layers of earth with wavy borders, and the nuggets, rocks, gems, bones and roots buried in them. */
const Ground = memo(function Ground({ w, h, surfY }: { w: number; h: number; surfY: number }) {
  const k = Math.min(1, Math.max(0.65, w / 1000));
  const things = useMemo(() => {
    const rnd = random(w * 7 + h);
    const gh = h - surfY;
    const n = Math.round((w * gh) / (w < 600 ? 5200 : 8200));
    return Array.from({ length: n }, () => {
      const t = rnd();
      return { x: rnd() * w, y: surfY + 30 + rnd() * (gh - 30), r: (6 + rnd() * 12) * k, t, tw: rnd() < 0.4 ? rnd() * 3 : 0, c: ["#6ee7d8", "#ff7aa8", "#8cb8ff"][Math.floor(rnd() * 3)], rot: rnd() * 180 };
    });
  }, [w, h, surfY, k]);
  const gh = h - surfY;
  return (
    <g>
      {EARTH.map((c, i) => (
        <path key={c} d={wave(w, h, surfY + (gh * i) / EARTH.length, 5 + i, i * 1.7)} fill={c} stroke={i ? "#2a170c" : "none"} strokeWidth={2} />
      ))}
      {/* roots hanging from the grass */}
      {Array.from({ length: Math.round(w / 90) }, (_, i) => {
        const x = ((i + 0.5) * w) / Math.round(w / 90) + Math.sin(i * 3) * 20;
        return <path key={i} d={`M${x},${surfY} q${6 * Math.sin(i)},${20 * k} ${-8 * Math.cos(i)},${46 * k} t${10},${30 * k}`} stroke="#8a5a34" strokeWidth={2.2 * k} fill="none" strokeLinecap="round" />;
      })}
      {things.map((p, i) =>
        p.t < 0.36 ? <Nugget key={i} x={p.x} y={p.y} r={p.r} twinkle={p.tw} /> : p.t < 0.62 ? <Rock key={i} x={p.x} y={p.y} r={p.r * 0.9} /> : p.t < 0.72 ? <Gem key={i} x={p.x} y={p.y} r={p.r * 0.8} color={p.c} /> : p.t < 0.8 ? <Bone key={i} x={p.x} y={p.y} r={p.r * 0.9} rot={p.rot} /> : <circle key={i} cx={p.x} cy={p.y} r={p.r * 0.35} fill="#3a2214" opacity={0.7} />,
      )}
      {/* dust motes drifting */}
      {Array.from({ length: 14 }, (_, i) => (
        <circle key={i} className="mote" cx={(i * 977) % w} cy={surfY + 40 + ((i * 131) % Math.max(1, gh - 60))} r={1.6 * k + 0.6} fill="#ffe9c2" style={{ animationDelay: `${i * 0.7}s` }} />
      ))}
    </g>
  );
});

/** Sky with stars, moon, far hills and drifting clouds; the grass line at `surfY`. */
const Sky = memo(function Sky({ w, surfY }: { w: number; surfY: number }) {
  const stars = useMemo(() => {
    const rnd = random(11);
    return Array.from({ length: 28 }, () => ({ x: rnd() * w, y: rnd() * surfY * 0.55, r: 0.6 + rnd() * 1.3, d: rnd() * 3 }));
  }, [w, surfY]);
  return (
    <g>
      <rect width={w} height={surfY + 12} fill="url(#sky)" />
      {stars.map((s, i) => (
        <circle key={i} className="star" cx={s.x} cy={s.y} r={s.r} fill="#fff6d8" style={{ animationDelay: `${s.d}s` }} />
      ))}
      <circle cx={w * 0.86} cy={surfY * 0.2 + 18} r={Math.min(26, surfY * 0.1)} fill="#fff3c9" stroke="#e9d493" strokeWidth={2} />
      <path d={wave(w, surfY + 14, surfY * 0.72, surfY * 0.06, 0.7).replace(/L\d+,\d+ L0,\d+ Z/, "")} fill="none" />
      <path d={wave(w, surfY + 14, surfY * 0.66, surfY * 0.07, 2)} fill="#3a2c55" />
      <path d={wave(w, surfY + 14, surfY * 0.8, surfY * 0.05, 4)} fill="#2f6a46" stroke={INK} strokeWidth={2} />
      <g className="cloud" opacity={0.85} fill="#ffd9c0" stroke="#e9a98a" strokeWidth={1.5}>
        <ellipse cx={w * 0.2} cy={surfY * 0.28} rx={w * 0.05} ry={surfY * 0.035} />
        <ellipse cx={w * 0.23} cy={surfY * 0.25} rx={w * 0.03} ry={surfY * 0.03} />
      </g>
      {/* the grass strip the camp stands on */}
      <path d={wave(w, surfY + 14, surfY - 14, 3, 1)} fill="#5ea143" stroke={INK} strokeWidth={2.4} />
      <path d={wave(w, surfY + 14, surfY - 14, 3, 1).replace(/ L\d+,\d+ L0,\d+ Z$/, "")} fill="none" stroke="#9bd66a" strokeWidth={2} transform="translate(0,3)" />
    </g>
  );
});

function Campfire({ x, y, s }: { x: number; y: number; s: number }) {
  const f = s / 80;
  return (
    <g transform={`translate(${x},${y}) scale(${f})`}>
      <circle className="glow" cx={0} cy={-18} r={120} fill="url(#glow)" />
      {/* stones */}
      {[-34, -20, 0, 20, 34].map((dx, i) => (
        <ellipse key={i} cx={dx} cy={i === 2 ? 8 : 4 - Math.abs(dx) / 8} rx={9} ry={6} fill="#8b9098" stroke="#2f3238" strokeWidth={2} />
      ))}
      <rect x={-30} y={-6} width={60} height={11} rx={5} transform="rotate(14)" fill="#7a4d2c" stroke={INK} strokeWidth={2.4} />
      <rect x={-30} y={-6} width={60} height={11} rx={5} transform="rotate(-14)" fill="#8d5a33" stroke={INK} strokeWidth={2.4} />
      <g className="fire">
        <path d="M0,-62 C10,-42 28,-34 26,-12 C24,4 -24,4 -26,-12 C-28,-30 -12,-38 0,-62 Z" fill="#f2642e" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        <path d="M0,-44 C8,-32 18,-26 16,-10 C14,0 -14,0 -16,-10 C-18,-24 -6,-30 0,-44 Z" fill="#f7a93b" />
        <path d="M0,-26 C5,-18 10,-14 8,-6 C6,0 -6,0 -8,-6 C-10,-14 -4,-18 0,-26 Z" fill="#ffe27a" />
      </g>
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} className="ember" cx={(i - 1.5) * 9} cy={-40} r={2.2} fill="#ffcf6b" style={{ animationDelay: `${i * 0.55}s` }} />
      ))}
    </g>
  );
}

/** A tent and a lantern on a pole, so the camp has a place. */
function Camp({ w, surfY }: { w: number; surfY: number }) {
  const k = Math.min(1, Math.max(0.55, w / 1000));
  const tx = w - 70 * k - 20;
  const lx = 66 * k + 30;
  return (
    <g>
      <g transform={`translate(${tx},${surfY - 6}) scale(${k})`}>
        <path d="M-52,0 L0,-62 L52,0 Z" fill="#c9512d" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
        <path d="M0,-62 L18,0 L-18,0 Z" fill="#2a1a12" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
        <path d="M-34,-12 L0,-58 L-8,-58 L-44,-10 Z" fill="#e57a52" opacity={0.7} />
      </g>
      <g transform={`translate(${lx},${surfY - 4}) scale(${k})`}>
        <rect x={-2.5} y={-70} width={5} height={70} fill="#6b4326" stroke={INK} strokeWidth={2} />
        <circle className="glow" cx={0} cy={-76} r={40} fill="url(#glow)" />
        <rect x={-9} y={-90} width={18} height={22} rx={4} fill="#ffe27a" stroke={INK} strokeWidth={2.2} />
        <path d="M-11,-90 L0,-100 L11,-90 Z" fill="#3a2314" stroke={INK} strokeWidth={2} />
      </g>
    </g>
  );
}

/** The cart on rails in the shaft at the left: it rolls up to the surface and back down for more gold. */
function Cart({ h, surfY, reduced }: { h: number; surfY: number; reduced: boolean }) {
  const bottom = h - 26;
  return (
    <g>
      <rect x={5} y={surfY} width={14} height={h - surfY} fill="#1c0f08" opacity={0.85} />
      <path d={`M7,${surfY} V${h} M17,${surfY} V${h}`} stroke="#9a9fa8" strokeWidth={2} />
      {Array.from({ length: Math.floor((h - surfY) / 18) }, (_, i) => (
        <rect key={i} x={4} y={surfY + 8 + i * 18} width={16} height={3} fill="#7a4d2c" />
      ))}
      <g transform={`translate(0,${reduced ? bottom : 0})`}>
        <g transform="translate(12,0)">
          <path d="M-10,-14 H10 L7,0 H-7 Z" fill="#9a5a2e" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <circle cx={-5} cy={2} r={3} fill="#555a63" stroke={INK} strokeWidth={1.5} />
          <circle cx={5} cy={2} r={3} fill="#555a63" stroke={INK} strokeWidth={1.5} />
          <circle cx={-3} cy={-16} r={4} fill="#f2b632" stroke="#7a4a05" strokeWidth={1.4} />
          <circle cx={3} cy={-17} r={3.4} fill="#f2b632" stroke="#7a4a05" strokeWidth={1.4} />
        </g>
        {!reduced && <animateMotion dur="11s" repeatCount="indefinite" path={`M0,${bottom} V${surfY + 24} V${bottom}`} keyPoints="0;0.47;0.5;0.97;1" keyTimes="0;0.45;0.55;0.95;1" calcMode="linear" />}
      </g>
    </g>
  );
}

/** One chubby worker in a 100x100 box, feet at (50,92): thick outline, group-colored hard hat with a lamp, T-shirt with initials. */
function Figure({ agent, state, delay }: { agent: Agent; state: WorkerState; delay: number }) {
  const { hat, initials } = groupLook(agent);
  const digging = state === "digging";
  const sw = 2.6;
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      <ellipse cx={50} cy={93} rx={25} ry={4.5} fill="#000" opacity={0.3} />
      <g className={digging ? "w-body w-body-dig" : "w-body"} style={{ animationDelay: `${delay}s` }}>
        <rect x={34} y={78} width={12} height={14} rx={5} fill="#3a2a22" stroke={INK} strokeWidth={sw} />
        <rect x={54} y={78} width={12} height={14} rx={5} fill="#3a2a22" stroke={INK} strokeWidth={sw} />
        <rect x={27} y={48} width={46} height={38} rx={17} fill="#f4efe4" stroke={INK} strokeWidth={sw} />
        <path d="M30,74 Q50,86 70,74 Q70,84 50,86 Q30,84 30,74 Z" fill="#d9d1bf" />
        <text x={50} y={72} textAnchor="middle" fontSize={initials.length > 2 ? 12 : 15} fontWeight={800} fontFamily="ui-sans-serif, system-ui" fill={INK} stroke="none">{initials}</text>
        {/* the arm on the left holds on */}
        <circle cx={25} cy={62} r={7} fill="#f6cfa3" stroke={INK} strokeWidth={sw} />
        {digging ? (
          <g className="w-pick" style={{ animationDelay: `${delay}s` }}>
            <rect x={68} y={36} width={6} height={44} rx={3} fill="#a8743c" stroke={INK} strokeWidth={sw} />
            <path d="M50,40 Q71,22 92,40 Q71,32 50,40 Z" fill="#c9ced6" stroke={INK} strokeWidth={sw} />
            <circle cx={71} cy={64} r={7} fill="#f6cfa3" stroke={INK} strokeWidth={sw} />
          </g>
        ) : (
          <g>
            <circle cx={75} cy={64} r={7} fill="#f6cfa3" stroke={INK} strokeWidth={sw} />
            <rect x={72} y={53} width={11} height={11} rx={3} fill="#e0e4ec" stroke={INK} strokeWidth={2} />
          </g>
        )}
        <circle cx={50} cy={34} r={24} fill="#f6cfa3" stroke={INK} strokeWidth={sw} />
        <path d="M36,52 Q50,58 64,52 Q64,56 50,58 Q36,56 36,52 Z" fill="#e3ac7c" stroke="none" />
        <ellipse cx={41} cy={37} rx={3.6} ry={4.6} fill={INK} stroke="none" />
        <ellipse cx={59} cy={37} rx={3.6} ry={4.6} fill={INK} stroke="none" />
        <circle cx={42.2} cy={35.4} r={1.2} fill="#fff" stroke="none" />
        <circle cx={60.2} cy={35.4} r={1.2} fill="#fff" stroke="none" />
        <circle cx={34} cy={46} r={4} fill="#f59a8a" opacity={0.55} stroke="none" />
        <circle cx={66} cy={46} r={4} fill="#f59a8a" opacity={0.55} stroke="none" />
        <path d={digging ? "M44,47 Q50,53 56,47" : "M44,46 Q50,52 56,46"} stroke={INK} strokeWidth={2.4} fill="none" />
        <path d="M23,33 C23,2 77,2 77,33 Z" fill={hat} stroke={INK} strokeWidth={sw} />
        <rect x={19} y={30} width={62} height={8} rx={4} fill={hat} stroke={INK} strokeWidth={sw} />
        <path d="M30,26 C32,12 44,8 52,9" stroke="#fff" strokeOpacity={0.55} strokeWidth={3} fill="none" />
        <circle className="lamp" cx={50} cy={16} r={11} fill="#ffe27a" opacity={0.35} stroke="none" />
        <circle cx={50} cy={16} r={5} fill="#ffe27a" stroke={INK} strokeWidth={2} />
      </g>
    </g>
  );
}

/** A worker in the scene: tapping opens its agent's chat; its name shows on hover or focus. */
function Placed({ agent, spot, state, i, children }: { agent: Agent; spot: Spot; state: WorkerState; i: number; children?: React.ReactNode }) {
  const go = useNavigate();
  const open = () => go(`/agents/${agent.id}`);
  const f = spot.s / 100;
  return (
    <g role="link" tabIndex={0} aria-label={`${agent.name}, ${state}`} className="w-link" onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      {children}
      <g transform={`translate(${spot.x - spot.s / 2},${spot.y - spot.s * 0.92}) scale(${f})`}>
        <Figure agent={agent} state={state} delay={(i * 0.37) % 1.2} />
        {state === "digging" && (
          <g className="w-spark" style={{ animationDelay: `${(i * 0.37) % 1.2}s` }} transform="translate(92,74)">
            <path d="M0,-12 L3,-3 L12,0 L3,3 L0,12 L-3,3 L-12,0 L-3,-3 Z" fill="#fff4b0" stroke="#f2b632" strokeWidth={1.5} />
          </g>
        )}
        <g className="w-tag">
          <rect x={50 - Math.min(48, agent.name.length * 4.6 + 8)} y={-22} width={Math.min(96, agent.name.length * 9.2 + 16)} height={19} rx={9} fill={INK} opacity={0.9} />
          <text x={50} y={-8.5} textAnchor="middle" fontSize={12} fontWeight={700} fontFamily="ui-sans-serif, system-ui" fill="#fff">{agent.name}</text>
        </g>
      </g>
    </g>
  );
}

/** The pocket dug into the earth around a digger: dark hollow, a lighter rim, wooden props, a nugget in the wall. */
function Pocket({ spot }: { spot: Spot }) {
  const { x, y, s } = spot;
  const rx = s * 0.6;
  const ry = s * 0.56;
  const cy = y - s * 0.46;
  return (
    <g>
      <ellipse cx={x} cy={cy} rx={rx} ry={ry} fill="#1e110a" stroke="#a8743c" strokeWidth={Math.max(2, s * 0.04)} />
      <ellipse cx={x} cy={cy + ry * 0.25} rx={rx * 0.8} ry={ry * 0.7} fill="#2b1a10" />
      <rect x={x - rx * 0.85} y={cy - ry * 0.7} width={s * 0.07} height={ry * 1.5} fill="#a8743c" stroke={INK} strokeWidth={1.4} />
      <rect x={x - rx * 0.95} y={cy - ry * 0.85} width={rx * 1.9} height={s * 0.07} rx={2} fill="#a8743c" stroke={INK} strokeWidth={1.4} />
      <Nugget x={x + s * 0.42} y={y - s * 0.3} r={s * 0.11} twinkle={1} />
    </g>
  );
}

/** The whole Workers scene for a layout. Diggers (`digs`) and resters (`rests`) are agents in layout order. */
export function WorkersScene({ layout, digs, rests, reduced }: { layout: SceneLayout; digs: Agent[]; rests: Agent[]; reduced: boolean }) {
  const { w, h, surfY } = layout;
  // Resters further up the surface are drawn first, so the nearer ones overlap them.
  const order = rests.map((a, i) => ({ a, i })).sort((p, q) => layout.rests[p.i].y - layout.rests[q.i].y);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" className={`block size-full select-none ${reduced ? "reduced" : ""}`} role="img" aria-label="Workers">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d1f4a" />
          <stop offset="0.55" stopColor="#6b3f6e" />
          <stop offset="1" stopColor="#f08a5d" />
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0" stopColor="#ffb347" stopOpacity={0.55} />
          <stop offset="1" stopColor="#ffb347" stopOpacity={0} />
        </radialGradient>
      </defs>
      <Sky w={w} surfY={surfY} />
      <Ground w={w} h={h} surfY={surfY} />
      <Cart h={h} surfY={surfY} reduced={reduced} />
      <Camp w={w} surfY={surfY} />
      {digs.map((a, i) => (
        <Placed key={a.id} agent={a} spot={layout.digs[i]} state="digging" i={i}>
          <Pocket spot={layout.digs[i]} />
        </Placed>
      ))}
      <Campfire x={layout.fire.x} y={layout.fire.y} s={layout.fire.s} />
      {order.map(({ a, i }) => (
        <Placed key={a.id} agent={a} spot={layout.rests[i]} state="resting" i={i} />
      ))}
    </svg>
  );
}
