import { test } from "node:test";
import assert from "node:assert/strict";
import { workerState, groupLook, initials, layout, HAT_COLORS, NEUTRAL_HAT, MIN_CELL, MAX_CELL } from "../src/lib/workers.ts";

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

test("the layout fits 1, 8 and 40 workers at 1440, 390 and 320 px without sideways overflow", () => {
  for (const width of [1440, 390, 320]) {
    for (const count of [1, 8, 40]) {
      const { cols, rows, cell } = layout(count, width);
      assert.ok(cols >= 1 && cols * cell <= width, `${count} at ${width}: ${cols} x ${cell}px`);
      assert.ok(cell >= MIN_CELL && cell <= MAX_CELL);
      assert.ok(cols * rows >= count && (rows - 1) * cols < count, "every worker has a cell, no empty row");
    }
  }
  assert.deepEqual(layout(1, 320), { cols: 1, rows: 1, cell: 104 });
  assert.deepEqual(layout(40, 320), { cols: 6, rows: 7, cell: 53 });
  assert.deepEqual(layout(0, 320), { cols: 0, rows: 0, cell: 0 });
});
