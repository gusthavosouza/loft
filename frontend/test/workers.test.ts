import { test } from "node:test";
import assert from "node:assert/strict";
import { caption, CAPTION_DOT, isReleasing, needyAgents, workerState, kindOf, groupLook, initials, HAT_COLORS, NEUTRAL, progress, phaseOf, pickHall, diffEvents, type RunningDelivery, type Overview } from "../src/lib/workers.ts";

test("a worker works while its agent runs and rests otherwise", () => {
  assert.equal(workerState({ status: "running" }), "working");
  for (const status of ["idle", "waiting", "error", ""]) assert.equal(workerState({ status }), "resting");
});

test("a role decides what the worker does; Custom and no role haul like a Dev", () => {
  assert.deepEqual(["lead", "dev", "qa", "security", "code_reviewer", "custom", undefined].map(kindOf), ["lead", "dev", "qa", "security", "reviewer", "dev", "dev"]);
});

test("initials are 1–3 letters from the group label", () => {
  assert.equal(initials("Dineout"), "DI");
  assert.equal(initials("Acme Corp"), "AC");
  assert.equal(initials("big old acme team"), "BOA");
  assert.equal(initials("x"), "X");
  assert.equal(initials("  "), "");
});

test("a group's look is stable, from the palette, and ignores case; the shirt never matches the hat", () => {
  const a = groupLook({ group: "Dineout" });
  assert.deepEqual(groupLook({ group: "dineout" }), a);
  assert.ok(HAT_COLORS.includes(a.hat));
  assert.equal(a.initials, "DI");
  const looks = ["Loft", "Dineout", "Acme", "Zed", "Notes", "Api", "Passora"].map((g) => groupLook({ group: g }));
  assert.ok(new Set(looks.map((l) => l.hat)).size > 2, "different groups mostly differ");
  for (const l of looks) assert.notEqual(l.hat, l.shirt);
});

test("an agent without a group gets the neutral look", () => {
  for (const group of [undefined, "", "  "]) assert.deepEqual(groupLook({ group }), { ...NEUTRAL, initials: "" });
});

const tk = (number: number, state: string) => ({ number, title: `T${number}`, state });
const del = (spec: number, dev: string, tickets: ReturnType<typeof tk>[]): RunningDelivery => ({ repo: "o/r", spec, title: `Spec ${spec}`, state: "running", pr: null, dev, current: null, tickets });

test("a Delivery's progress is its closed tickets out of all, and the phase follows the percentage", () => {
  assert.deepEqual(progress(del(1, "", [tk(2, "closed"), tk(3, "review"), tk(4, "open"), tk(5, "closed")])), { done: 2, total: 4, pct: 50 });
  assert.deepEqual(progress(del(1, "", [])), { done: 0, total: 0, pct: 0 });
  assert.deepEqual([0, 25, 26, 50, 51, 75, 76, 99, 100].map(phaseOf), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
});

test("the hall is the running Delivery whose Dev works now, else the newest; none is an empty lot", () => {
  const running = [del(2, "b", []), del(1, "a", [])];
  assert.equal(pickHall(running, [{ id: "a", status: "running" }, { id: "b", status: "idle" }])?.spec, 1);
  assert.equal(pickHall(running, [{ id: "a", status: "idle" }])?.spec, 2);
  assert.equal(pickHall([], [{ id: "a", status: "running" }]), null);
});

test("events: a ticket closing, one going into review, the spec merging; none on the first load or when nothing changed", () => {
  const before: Overview = { running: [del(1, "a", [tk(2, "started"), tk(3, "open"), tk(4, "review")])], merged: [] };
  assert.deepEqual(diffEvents(null, before), []);
  assert.deepEqual(diffEvents(before, before), []);
  const after: Overview = { running: [del(1, "a", [tk(2, "review"), tk(3, "open"), tk(4, "closed")])], merged: [] };
  assert.deepEqual(diffEvents(before, after), [{ type: "review", key: "o/r#1", number: 2 }, { type: "closed", key: "o/r#1", number: 4 }]);
  const merged: Overview = { running: [], merged: [{ repo: "o/r", spec: 1, title: "Spec 1" }] };
  assert.deepEqual(diffEvents(after, merged), [{ type: "merged", key: "o/r#1", spec: 1, title: "Spec 1" }]);
  assert.deepEqual(diffEvents(after, { running: [], merged: [] }), [], "closed without a merge is no celebration");
});

test("the caption follows the priority: Waiting for you, Releasing, Working, Resting", () => {
  const f = { needsYou: false, releasing: false, working: false };
  assert.equal(caption(f), "Resting");
  assert.equal(caption({ ...f, working: true }), "Working");
  assert.equal(caption({ ...f, working: true, releasing: true }), "Releasing");
  assert.equal(caption({ needsYou: true, releasing: true, working: true }), "Waiting for you");
  assert.equal(caption({ ...f, needsYou: true }), "Waiting for you");
});

test("an agent holds the sign while a Needs you item names it, and stops when the item clears", () => {
  const item = (id: string | null) => ({ agent: id ? { id } : null });
  assert.deepEqual([...needyAgents([item("a"), item(null), item("b"), item("a")])].sort(), ["a", "b"]);
  const open = needyAgents([item("a")]);
  assert.ok(open.has("a") && !open.has("b"));
  assert.equal(needyAgents([]).has("a"), false, "cleared: back to digging or resting");
});

test("Releasing follows a spec PR found ready and not merged, or a merge being celebrated", () => {
  const ov = (releasing?: { repo: string; spec: number }[]) => ({ running: [], merged: [], releasing });
  assert.equal(isReleasing(null, false), false);
  assert.equal(isReleasing(ov(), false), false);
  assert.equal(isReleasing(ov([]), false), false);
  assert.equal(isReleasing(ov([{ repo: "o/r", spec: 9 }]), false), true);
  assert.equal(isReleasing(ov(), true), true);
});

test("every caption has its own dot colour for the navigation button", () => {
  const all = (["Waiting for you", "Releasing", "Working", "Resting"] as const).map((c) => CAPTION_DOT[c]);
  assert.equal(new Set(all).size, 4);
});

test("a Needs you item that names no agent does not make the navigation button wait", () => {
  assert.equal(needyAgents([{ agent: null }]).size, 0);
});
