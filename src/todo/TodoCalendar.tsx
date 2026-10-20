import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCalendarLine,
  RiCheckLine,
  RiMoreLine,
  RiTimeLine,
} from "@remixicon/react";
import { useTheme, type Accent } from "../theme";
import type { Todo } from "./api";
import {
  busyMinutes,
  calendarTime,
  clockAt,
  HOUR_HEIGHT,
  layoutDay,
  MIN_EVENT_MINUTES,
  monthDays,
  shiftMonth,
  todosOnDay,
  weekDays,
  type CalendarMode,
} from "./calendar";
import { fullDateLabel, shiftKey, weekdayLabel } from "./dates";
import { QUADRANTS, quadrantStyle } from "./palette";
import type { TodoScope } from "./views";
import "./calendar.css";

type ComposerSlot = { day: string; start: string | null; end: string | null };
type CalendarActions = {
  onOpenDetail: (id: string) => void;
  onMenu: (todo: Todo, x: number, y: number) => void;
  onToggle: (todo: Todo) => void;
};

export function TodoCalendar({
  accent,
  scope,
  today,
  visible,
  loading,
  renderComposer,
  ...actions
}: CalendarActions & {
  accent: Accent;
  scope: TodoScope;
  today: string;
  visible: Todo[];
  loading: boolean;
  renderComposer: (slot: ComposerSlot) => ReactNode;
}) {
  const { t } = useTheme();
  const [mode, setMode] = useState<CalendarMode>(
    scope === "today" ? "day" : scope === "week" ? "week" : "month",
  );
  const [slot, setSlot] = useState<ComposerSlot>({ day: today, start: null, end: null });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const days = useMemo(
    () =>
      mode === "month" ? monthDays(slot.day) : mode === "week" ? weekDays(slot.day) : [slot.day],
    [mode, slot.day],
  );
  const byDay = useMemo(
    () => new Map(days.map((day) => [day, todosOnDay(visible, day)])),
    [days, visible],
  );
  const undated = visible.filter((todo) => !todo.dueDate);
  const selectedTodos = todosOnDay(visible, slot.day);
  const busy = busyMinutes(visible, slot.day);
  const month = slot.day.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  const heading =
    mode === "month"
      ? `${year}年${monthNumber}月`
      : mode === "day"
        ? fullDateLabel(slot.day)
        : `${fullDateLabel(days[0]).split(" ")[0]} — ${fullDateLabel(days[6]).split(" ")[0]}`;
  const navigate = (delta: number) =>
    setSlot({
      day:
        mode === "month"
          ? shiftMonth(slot.day, delta)
          : shiftKey(slot.day, delta * (mode === "week" ? 7 : 1)),
      start: null,
      end: null,
    });
  const openDay = (day: string) => {
    setSlot({ day, start: null, end: null });
    setMode("day");
  };
  const variables = {
    "--cal-surface": t.cardSurface,
    "--cal-alt": t.cardSurfaceAlt,
    "--cal-text": t.textPrimary,
    "--cal-secondary": t.textSecondary,
    "--cal-muted": t.textTertiary,
    "--cal-line": t.separator,
    "--cal-hover": t.controlHover,
    "--cal-accent": accent.accent,
    "--cal-accent-text": accent.accentText,
    "--cal-selected": accent.selectedFill,
  } as CSSProperties;

  return (
    <section aria-label="待办日历" className="todo-calendar" style={variables}>
      <div className="todo-cal-toolbar">
        <div className="todo-cal-navigation">
          <button
            aria-label="上一页日历"
            className="todo-cal-icon"
            onClick={() => navigate(-1)}
            type="button"
          >
            <RiArrowLeftSLine size={18} />
          </button>
          <button
            aria-label="下一页日历"
            className="todo-cal-icon"
            onClick={() => navigate(1)}
            type="button"
          >
            <RiArrowRightSLine size={18} />
          </button>
          <h2 aria-live="polite">{heading}</h2>
          <button
            className="todo-cal-today"
            onClick={() => setSlot({ day: today, start: null, end: null })}
            type="button"
          >
            今天
          </button>
        </div>
        <div aria-label="日历显示范围" className="todo-cal-modes">
          {(
            [
              ["month", "月"],
              ["week", "周"],
              ["day", "日"],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={mode === value}
              key={value}
              onClick={() => setMode(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {scope !== "done" ? (
        <div className="todo-cal-composer">
          <span className="todo-cal-composer-date">
            <RiCalendarLine size={13} />
            {Number(slot.day.slice(5, 7))}月{Number(slot.day.slice(8))}日
          </span>
          {slot.start ? (
            <button
              className="todo-cal-slot"
              onClick={() => setSlot({ ...slot, start: null, end: null })}
              title="清除预选时段"
              type="button"
            >
              {slot.start}–{slot.end} ×
            </button>
          ) : null}
          <div className="todo-cal-composer-input">{renderComposer(slot)}</div>
        </div>
      ) : null}

      {undated.length > 0 ? (
        <details className="todo-cal-undated">
          <summary>
            未安排日期 <span>{undated.length}</span>
            <small>展开查看并安排</small>
          </summary>
          <div className="todo-cal-undated-list">
            {undated.map((todo) => (
              <CalendarCard key={todo.id} todo={todo} {...actions} />
            ))}
          </div>
        </details>
      ) : null}

      {loading ? (
        <div className="todo-cal-loading" role="status">
          正在加载日程…
        </div>
      ) : null}

      {mode === "month" ? (
        <div className="todo-cal-month">
          <div className="todo-cal-weekdays">
            {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="todo-cal-month-grid">
            {days.map((day) => {
              const items = [...(byDay.get(day) ?? [])].sort(
                (a, b) =>
                  (a.startTime ?? a.endTime ?? "99:99").localeCompare(
                    b.startTime ?? b.endTime ?? "99:99",
                  ) ||
                  a.quadrant - b.quadrant ||
                  a.order - b.order,
              );
              return (
                <div className="todo-cal-cell" data-outside={day.slice(0, 7) !== month} key={day}>
                  <div className="todo-cal-cell-top">
                    <button
                      aria-current={day === today ? "date" : undefined}
                      aria-label={`${fullDateLabel(day)}，${items.length} 项安排，查看日程`}
                      className="todo-cal-date"
                      onClick={() => openDay(day)}
                      type="button"
                    >
                      {Number(day.slice(8))}
                    </button>
                    {scope !== "done" ? (
                      <button
                        aria-label={`添加 ${day} 的待办`}
                        className="todo-cal-cell-add"
                        onClick={() => openDay(day)}
                        type="button"
                      >
                        <RiAddLine size={13} />
                      </button>
                    ) : null}
                  </div>
                  <div className="todo-cal-cell-events">
                    {items.slice(0, 2).map((todo) => (
                      <CalendarCard compact key={todo.id} todo={todo} {...actions} />
                    ))}
                    {items.length > 2 ? (
                      <button className="todo-cal-more" onClick={() => openDay(day)} type="button">
                        还有 {items.length - 2} 项
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <TimeGrid
          actions={actions}
          byDay={byDay}
          days={days}
          key={`${mode}:${days[0]}`}
          now={now}
          onOpenDay={openDay}
          onPickSlot={scope === "done" ? undefined : setSlot}
          selectedDay={slot.day}
          today={today}
        />
      )}

      <div className="todo-cal-footer">
        <div className="todo-cal-legend">
          {QUADRANTS.map((quadrant) => (
            <span key={quadrant.id}>
              <i style={{ background: quadrant.color }} />
              {quadrant.label}
            </span>
          ))}
        </div>
        <span className="todo-cal-hint">
          {mode === "month"
            ? "点击日期查看当天时间线"
            : mode === "day"
              ? `${selectedTodos.length} 项安排 · 已安排 ${Math.floor(busy / 60)} 小时${busy % 60 ? ` ${busy % 60} 分钟` : ""}`
              : scope === "done"
                ? "点击日期查看当天已完成的安排"
                : "点击日期查看当天 · 点击空白时段添加"}
        </span>
      </div>
    </section>
  );
}

function CalendarCard({
  todo,
  compact = false,
  timeLabel,
  style,
  ...actions
}: CalendarActions & {
  todo: Todo;
  compact?: boolean;
  timeLabel?: string;
  style?: CSSProperties;
}) {
  const quadrant = quadrantStyle(todo.quadrant);
  const time = calendarTime(todo);
  const label = timeLabel ?? time?.label ?? (todo.endDate ? "跨日 · 未设时间" : "未设时间");
  const cardStyle = {
    "--event-color": quadrant.color,
    "--event-fill": quadrant.tint,
    ...style,
  } as CSSProperties;
  return (
    <div
      className={`todo-cal-event${compact ? " is-compact" : ""}`}
      data-done={todo.done}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.onMenu(todo, event.clientX, event.clientY);
      }}
      style={cardStyle}
    >
      {!compact ? (
        <button
          aria-label={`${todo.done ? "标记未完成" : "完成"}：${todo.title}`}
          aria-pressed={todo.done}
          className="todo-cal-check"
          onClick={() => actions.onToggle(todo)}
          type="button"
        >
          {todo.done ? <RiCheckLine size={11} /> : null}
        </button>
      ) : null}
      <button
        aria-label={`${todo.title}，${label}${time?.invalid ? "，结束时间早于开始时间，请调整" : ""}`}
        className="todo-cal-event-main"
        onClick={() => actions.onOpenDetail(todo.id)}
        title={`${todo.title}\n${label}${todo.endDate ? `\n${todo.dueDate} → ${todo.endDate}（每天）` : ""}${time?.invalid ? "\n请调整结束时间" : ""}`}
        type="button"
      >
        {compact && time ? (
          <span className="todo-cal-compact-time">{todo.startTime ?? todo.endTime}</span>
        ) : null}
        <span className="todo-cal-event-title">{todo.title}</span>
        {!compact ? (
          <span className="todo-cal-event-meta">
            {label}
            {todo.endDate && time ? " · 每天" : ""}
            {time?.invalid ? " · 时间待调整" : ""}
          </span>
        ) : null}
      </button>
      <button
        aria-label={`编辑安排：${todo.title}`}
        className="todo-cal-event-menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          actions.onMenu(todo, rect.left, rect.bottom + 4);
        }}
        title="编辑日期、时间和其他信息"
        type="button"
      >
        <RiMoreLine size={13} />
      </button>
    </div>
  );
}

function TimeGrid({
  actions,
  byDay,
  days,
  now,
  onOpenDay,
  onPickSlot,
  selectedDay,
  today,
}: {
  actions: CalendarActions;
  byDay: Map<string, Todo[]>;
  days: string[];
  now: Date;
  onOpenDay: (day: string) => void;
  onPickSlot?: (slot: ComposerSlot) => void;
  selectedDay: string;
  today: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(false);
  useEffect(() => {
    if (initialScroll.current || !scrollRef.current) return;
    const timed = days.flatMap((day) =>
      (byDay.get(day) ?? []).flatMap((todo) => {
        const time = calendarTime(todo);
        return time ? [time.start / 60] : [];
      }),
    );
    const hour = days.includes(today)
      ? new Date().getHours() - 1
      : timed.length
        ? Math.min(...timed) - 1
        : 8;
    scrollRef.current.scrollTop = Math.max(0, hour) * HOUR_HEIGHT;
    initialScroll.current = true;
  }, [byDay, days, today]);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const isDay = days.length === 1;
  return (
    <div
      aria-label={isDay ? "当天时间线" : "本周时间线"}
      className={`todo-cal-time-scroll${isDay ? " is-day" : ""}`}
      ref={scrollRef}
    >
      <div className="todo-cal-time-inner" style={{ "--day-count": days.length } as CSSProperties}>
        <div className="todo-cal-day-heads todo-cal-columns">
          <div className="todo-cal-time-zone">24 小时</div>
          {days.map((day) => (
            <button
              aria-label={`查看 ${fullDateLabel(day)} 的日程`}
              className="todo-cal-day-head"
              data-selected={day === selectedDay}
              key={day}
              onClick={() => onOpenDay(day)}
              type="button"
            >
              <span>{weekdayLabel(day)}</span>
              <strong aria-current={day === today ? "date" : undefined}>
                {Number(day.slice(8))}
              </strong>
              <small>{byDay.get(day)?.length ?? 0} 项</small>
            </button>
          ))}
        </div>
        <div className="todo-cal-all-day todo-cal-columns">
          <span className="todo-cal-all-day-label">未设时间</span>
          {days.map((day) => (
            <div className="todo-cal-all-day-cell" key={day}>
              {(byDay.get(day) ?? [])
                .filter((todo) => !calendarTime(todo))
                .map((todo) => (
                  <CalendarCard key={todo.id} todo={todo} {...actions} />
                ))}
            </div>
          ))}
        </div>
        <div
          className="todo-cal-time-body todo-cal-columns"
          style={{ height: 24 * HOUR_HEIGHT + 48 }}
        >
          <div aria-hidden="true" className="todo-cal-hours">
            {Array.from({ length: 25 }, (_, hour) => (
              <span key={hour} style={{ top: hour * HOUR_HEIGHT }}>
                {`${hour}`.padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {days.map((day) => {
            const items = byDay.get(day) ?? [];
            const events = layoutDay(items, day);
            return (
              <div
                aria-label={`${fullDateLabel(day)} 时间线`}
                className="todo-cal-time-day"
                key={day}
              >
                {Array.from({ length: 48 }, (_, index) => (
                  <button
                    aria-label={`${day} ${clockAt(index * 30)} 添加待办`}
                    className="todo-cal-time-slot"
                    disabled={!onPickSlot}
                    key={index}
                    onClick={() =>
                      onPickSlot?.({
                        day,
                        start: clockAt(index * 30),
                        end: clockAt(Math.min(index * 30 + 60, 1439)),
                      })
                    }
                    style={{ height: HOUR_HEIGHT / 2 }}
                    type="button"
                  />
                ))}
                {events.length === 0 && isDay ? (
                  <div className="todo-cal-time-empty">
                    <RiTimeLine size={24} />
                    <strong>留一点时间给自己</strong>
                    <span>
                      {items.length
                        ? "未设时间的待办在上方，随时可以安排时段。"
                        : "这一天还没有安排。"}
                      {onPickSlot ? "点击空白时段，开始安排一天。" : ""}
                    </span>
                  </div>
                ) : null}
                {events.map(({ todo, time, column, columns }) => {
                  const height =
                    (Math.max(time.end - time.start, MIN_EVENT_MINUTES) / 60) * HOUR_HEIGHT - 3;
                  return (
                    <CalendarCard
                      key={todo.id}
                      style={{
                        position: "absolute",
                        top: (time.start / 60) * HOUR_HEIGHT,
                        height,
                        left: `calc(${(column / columns) * 100}% + 3px)`,
                        width: `calc(${100 / columns}% - 6px)`,
                      }}
                      timeLabel={time.label}
                      todo={todo}
                      {...actions}
                    />
                  );
                })}
                {day === today ? (
                  <div
                    aria-label={`当前时间 ${clockAt(minutesNow)}`}
                    className="todo-cal-now"
                    style={{ top: (minutesNow / 60) * HOUR_HEIGHT }}
                  >
                    <i />
                    <span>{clockAt(minutesNow)}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
