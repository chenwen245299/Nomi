import assert from "node:assert/strict";
import { test } from "node:test";
import {
  busyMinutes,
  calendarTime,
  clockAt,
  layoutDay,
  MIN_EVENT_MINUTES,
  monthDays,
  shiftMonth,
  todosOnDay,
  weekDays,
} from "../src/todo/calendar.ts";

const day = "2026-10-20";
function todo(id, startTime = null, endTime = null, fields = {}) {
  return {
    id,
    title: id,
    notes: "",
    quadrant: 2,
    dueDate: day,
    endDate: null,
    startTime,
    endTime,
    recurrence: "none",
    recurrenceAnchorDate: null,
    done: false,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    order: 0,
    ...fields,
  };
}

test("Monday-first weeks and six-row months include adjacent years and leap days", () => {
  assert.equal(weekDays("2027-01-01")[0], "2026-12-28");
  assert.equal(weekDays("2027-01-03")[6], "2027-01-03");
  const month = monthDays("2024-02-29");
  assert.equal(month.length, 42);
  assert.equal(month[0], "2024-01-29");
  assert.ok(month.includes("2024-02-29"));
  assert.equal(new Set(month).size, 42);
  assert.equal(shiftMonth("2024-01-31", 1), "2024-02-29");
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftMonth("2026-12-20", 1), "2027-01-20");
  assert.deepEqual(weekDays("2026-03-08"), [
    "2026-03-02",
    "2026-03-03",
    "2026-03-04",
    "2026-03-05",
    "2026-03-06",
    "2026-03-07",
    "2026-03-08",
  ]);
});

test("date spans occupy every included day without imposing the list's 400-day cap", () => {
  const items = [
    todo("one"),
    todo("span", "09:00", "10:00", { dueDate: "2026-10-19", endDate: "2026-10-21" }),
    todo("long", null, null, { dueDate: "2020-01-01", endDate: "2030-01-01" }),
    todo("undated", "09:00", null, { dueDate: null }),
  ];
  assert.deepEqual(
    todosOnDay(items, day).map((item) => item.id),
    ["one", "span", "long"],
  );
  assert.deepEqual(
    todosOnDay(items, "2026-10-21").map((item) => item.id),
    ["span", "long"],
  );
  assert.deepEqual(
    todosOnDay(items, "2026-10-22").map((item) => item.id),
    ["long"],
  );
  assert.equal(layoutDay(items, "2026-10-21")[0].time.start, 540);
});

test("a single clock is a point; reversed and malformed times never produce negative blocks", () => {
  assert.deepEqual(calendarTime(todo("deadline", null, "23:59")), {
    start: 1439,
    end: 1439,
    label: "截至 23:59",
    invalid: false,
  });
  assert.equal(calendarTime(todo("start", "00:00")).end, 0);
  assert.equal(calendarTime(todo("untimed")), null);
  assert.equal(calendarTime(todo("malformed", "24:00", "nope")), null);
  assert.deepEqual(calendarTime(todo("reversed", "15:00", "09:00")), {
    start: 900,
    end: 900,
    label: "15:00–09:00",
    invalid: true,
  });
  assert.equal(clockAt(0), "00:00");
  assert.equal(clockAt(1439), "23:59");
});

test("overlapping tasks share columns throughout a transitive cluster, while adjacent ranges stay separate", () => {
  const items = [
    todo("a", "09:00", "10:00"),
    todo("b", "09:30", "10:30"),
    todo("c", "10:00", "11:00"),
    todo("d", "11:00", "12:00"),
  ];
  const packed = layoutDay(items, day);
  assert.deepEqual(
    packed.map(({ todo, column, columns }) => [todo.id, column, columns]),
    [
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 2],
      ["d", 0, 1],
    ],
  );
  assert.deepEqual(layoutDay([...items].reverse(), day), packed);
  assert.equal(items[0].column, undefined);
});

test("short tasks and deadline points remain clickable without covering neighboring events", () => {
  const packed = layoutDay(
    [todo("short", "09:00", "09:05"), todo("point", null, "09:10"), todo("midnight", "23:59")],
    day,
  );
  assert.equal(packed[0].columns, 2);
  assert.equal(packed[1].column, 1);
  assert.equal(packed[2].time.start, 1439);
  for (const a of packed) {
    for (const b of packed) {
      if (a === b || a.column !== b.column) continue;
      const aEnd = Math.max(a.time.end, a.time.start + MIN_EVENT_MINUTES);
      const bEnd = Math.max(b.time.end, b.time.start + MIN_EVENT_MINUTES);
      assert.ok(aEnd <= b.time.start || bEnd <= a.time.start);
    }
  }
});

test("busy time counts overlapping minutes once and excludes completed, undated, and point tasks", () => {
  assert.equal(
    busyMinutes(
      [
        todo("a", "09:00", "10:30"),
        todo("b", "10:00", "11:00"),
        todo("c", "12:00", "13:00"),
        todo("done", "14:00", "15:00", { done: true }),
        todo("no-day", "15:00", "16:00", { dueDate: null }),
        todo("point", "16:00"),
        todo("bad", "18:00", "17:00"),
      ],
      day,
    ),
    180,
  );
});
