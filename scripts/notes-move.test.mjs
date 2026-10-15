import assert from "node:assert/strict";
import { test } from "node:test";
import { canMoveNode, remapExpanded } from "../src/notes/treeMove.ts";
import { flushNotesUnder, registerNoteFlush } from "../src/notes/flushRegistry.ts";

test("notes can move between folders and to the root, while same-parent drops do nothing", () => {
  const note = { kind: "note", path: "工作/周报.md" };
  assert.equal(canMoveNode(note, "归档"), true);
  assert.equal(canMoveNode(note, ""), true);
  assert.equal(canMoveNode(note, "工作"), false);
  assert.equal(canMoveNode({ kind: "note", path: "周报.md" }, ""), false);
});

test("folder moves reject cycles using path boundaries rather than name prefixes", () => {
  const folder = { kind: "folder", path: "研究" };
  assert.equal(canMoveNode(folder, "研究"), false);
  assert.equal(canMoveNode(folder, "研究/资料/论文"), false);
  assert.equal(canMoveNode(folder, "研究归档"), true);
  assert.equal(canMoveNode(folder, "工作/研究"), true);
});

test("expanded descendants follow a moved or disambiguated folder and survive reopening", () => {
  const original = new Set(["研究", "研究/资料", "研究/资料/论文", "研究归档", "工作"]);
  const remapped = remapExpanded(original, "研究", "工作/研究-2");
  assert.deepEqual(
    [...remapped],
    ["工作/研究-2", "工作/研究-2/资料", "工作/研究-2/资料/论文", "研究归档", "工作"],
  );
  assert.deepEqual([...original], ["研究", "研究/资料", "研究/资料/论文", "研究归档", "工作"]);
});

test("moving a folder waits for its unsaved notes and leaves similarly named siblings alone", async () => {
  let finishSave;
  let saved = false;
  const unregister = [
    registerNoteFlush("研究/资料/论文.md", async () => {
      await new Promise((resolve) => {
        finishSave = resolve;
      });
      saved = true;
    }),
    registerNoteFlush("研究归档/保留.md", async () => {
      assert.fail("an unrelated note should not be flushed");
    }),
  ];
  try {
    const pending = flushNotesUnder("研究");
    assert.equal(saved, false);
    finishSave();
    await pending;
    assert.equal(saved, true);
  } finally {
    unregister.forEach((remove) => remove());
  }
});

test("a failed save rejects the pre-move flush instead of allowing unsaved edits to be lost", async () => {
  const unregister = registerNoteFlush("失败.md", async () => {
    throw new Error("磁盘写入失败");
  });
  try {
    await assert.rejects(flushNotesUnder("失败.md"), /磁盘写入失败/);
  } finally {
    unregister();
  }
});
