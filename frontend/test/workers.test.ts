import { test } from "node:test";
import assert from "node:assert/strict";
import { workerState, groupLook, initials, sceneLayout, HAT_COLORS, NEUTRAL_HAT } from "../src/lib/workers.ts";

test("a worker digs while its agent runs and rests otherwise", () => {
  assert.equal(workerState({ status: "running" }), "digging");
  for (const status of ["idle", "waiting", "error", ""]) assert.equal(workerState({ status }), "resting");
});

test("initials are 1–3 letters from the group label", () => {
  assert.equal(initials("Dineout"), "DI");
  assert.equal(initials("loft"), "LO");
  assert.equal(initials("Acme Corp"), "AC");
  assert.equal(initials("big old acme team"), "BOA");
  assert.equal(initials("x"), "X");
  assert.equal(initials("  "), "");
});

test("a group's hat color is stable, from the palette, and ignores case", () => {
  const a = groupLook({ group: "Dineout" });
  assert.deepEqual(groupLook({ group: "Dineout" }), a);
  assert.deepEqual(groupLook({ group: "dineout" }).hat, a.hat);
  assert.ok(HAT_COLORS.includes(a.hat));
  assert.equal(a.initials, "DI");
  const hats = new Set(["Loft", "Dineout", "Acme", "Zed", "Notes", "Api"].map((g) => groupLook({ group: g }).hat));
  assert.ok(hats.size > 2, "different groups mostly differ");
});

test("an agent without a group is neutral, whatever its project", () => {
  assert.deepEqual(groupLook({ group: "" }), { hat: NEUTRAL_HAT, initials: "" });
  assert.deepEqual(groupLook({ group: " " }), { hat: NEUTRAL_HAT, initials: "" });
  assert.deepEqual(groupLook({}), { hat: NEUTRAL_HAT, initials: "" });
});

test("the scene fits 1, 8 and 40 workers on a wide and a narrow canvas: inside it, diggers apart, resters on the surface", () => {
  for (const [w, h] of [[1000, 590], [400, 800], [400, 500]]) {
    for (const total of [1, 8, 40]) {
      for (const dig of [0, Math.floor(total / 2), total]) {
        const l = sceneLayout(dig, total - dig, w, h);
        assert.equal(l.digs.length, dig);
        assert.equal(l.rests.length, total - dig);
        const label = `${dig}+${total - dig} on ${w}x${h}`;
        for (const p of [...l.digs, ...l.rests]) {
          assert.ok(p.x - p.s / 2 >= 0 && p.x + p.s / 2 <= w && p.y - p.s >= 0 && p.y <= h, `inside: ${label}`);
        }
        for (const p of l.digs) assert.ok(p.y - p.s >= l.surfY, `diggers are underground: ${label}`);
        for (const p of l.rests) assert.ok(p.y <= l.surfY + 8, `resters are on the surface: ${label}`);
        for (const [i, a] of l.digs.entries()) {
          for (const b of l.digs.slice(i + 1)) {
            const apart = Math.abs(a.x - b.x) >= (a.s + b.s) / 2 - 1 || Math.abs(a.y - b.y) >= (a.s + b.s) / 2 - 1;
            assert.ok(apart, `diggers don't overlap: ${label}`);
          }
        }
      }
    }
  }
});

test("a lone worker is big and many are smaller", () => {
  assert.ok(sceneLayout(1, 0, 1000, 590).digs[0].s > sceneLayout(40, 0, 1000, 590).digs[0].s * 1.3);
  assert.ok(sceneLayout(0, 1, 1000, 590).rests[0].s > sceneLayout(0, 40, 1000, 590).rests[0].s);
});
