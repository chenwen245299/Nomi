import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { createPortal } from "react-dom";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCalendarTodoLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiFilter3Line,
  RiFolderOpenLine,
  RiGlobalLine,
  RiMap2Line,
  RiMapPin2Fill,
  RiMapPin2Line,
  RiRoadMapLine,
  RiSearch2Line,
  RiStackLine,
  RiTimeLine,
  RiTrafficLightLine,
} from "@remixicon/react";
import { EmptyIllustration } from "../illustrations";
import { motion, useTheme, type Accent, type Theme } from "../theme";
import { MapView, type MapHandle, type MapMarker, type MapRoute } from "./MapView";
import type { MapLayerId } from "./mapStyle";
import { OfflineMaps } from "./OfflineMaps";
import { TravelNoteEditor } from "./TravelNoteEditor";
import { LocationPicker } from "./LocationPicker";
import { StarChip } from "../ratings";
import { litRegions, type RegionCollection, type RegionLevel } from "./adminBoundaries";
import { travelCategoryColor, travelCategoryLabel } from "./categoryColors";
import {
  readNote,
  readNoteAssets,
  revealTravel,
  type NoteInput,
  type PlanStop,
  type TravelNote,
  type TravelPlan,
} from "./api";
import type { TravelData } from "./useTravel";

type PressState = { pressed: boolean; hovered?: boolean };
type TravelView = "map" | "trajectory" | "planning";
type PlanDayFilter = "all" | number;

const MAP_LAYER_SELECTION_KEY = "nomi.travel.map-layer.v2";
const MAP_LAYER_OPTIONS: {
  id: MapLayerId;
  label: string;
  description: string;
  onlineOnly?: boolean;
  preview: { background: string; detail: string; water: string };
}[] = [
  {
    id: "auto",
    label: "自动",
    description: "使用推荐的标准地图",
    preview: { background: "#E9E4D8", detail: "#D6B77C", water: "#A9C9E8" },
  },
  {
    id: "standard",
    label: "标准",
    description: "道路、地点与行政信息",
    preview: { background: "#E8E2D3", detail: "#D49B64", water: "#9EC5E8" },
  },
  {
    id: "light",
    label: "简洁",
    description: "弱化地图信息，突出标记",
    preview: { background: "#F3F3F0", detail: "#CFD2D4", water: "#D7E8F2" },
  },
  {
    id: "terrain",
    label: "地形",
    description: "突出山地、水系与自然地貌",
    onlineOnly: true,
    preview: { background: "#D7E0C8", detail: "#91A478", water: "#9DBED0" },
  },
  {
    id: "satellite",
    label: "卫星",
    description: "Sentinel-2 卫星影像",
    onlineOnly: true,
    preview: { background: "#567052", detail: "#A28E64", water: "#426D82" },
  },
  {
    id: "dark",
    label: "深色",
    description: "低亮度地图样式",
    preview: { background: "#27313A", detail: "#6C7477", water: "#1C465B" },
  },
];
const PLAN_DAY_COLORS = [
  "#E76F51",
  "#3A9D7D",
  "#477DB3",
  "#8A63B8",
  "#D08A32",
  "#C05676",
  "#3D8F9D",
  "#707B8F",
];

function planDayColor(day: number): string {
  return PLAN_DAY_COLORS[(Math.max(1, day) - 1) % PLAN_DAY_COLORS.length];
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function planDayCount(plan: TravelPlan): number {
  const maxStopDay = plan.stops.reduce((max, stop) => Math.max(max, stop.day || 1), 1);
  const start = parseLocalDate(plan.startDate);
  const end = parseLocalDate(plan.endDate);
  const dateDays =
    start && end && end >= start
      ? Math.min(90, Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1)
      : 1;
  return Math.max(maxStopDay, dateDays);
}

function planDayDate(plan: TravelPlan, day: number): string {
  const start = parseLocalDate(plan.startDate);
  if (!start) return "";
  start.setDate(start.getDate() + day - 1);
  return `${String(start.getMonth() + 1).padStart(2, "0")}/${String(start.getDate()).padStart(2, "0")}`;
}

function parsePlanTime(value: string): number | null {
  const normalized = value.trim().replace(/：/g, ":");
  if (!normalized) return null;

  const localized = /^(上午|下午|凌晨|中午|晚上)\s*(\d{1,2}):(\d{2})$/.exec(normalized);
  const english = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(normalized);
  const compact = /^(\d{1,2})(\d{2})$/.exec(normalized);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(normalized);

  let hours: number;
  let minutes: number;
  if (localized) {
    hours = Number(localized[2]);
    minutes = Number(localized[3]);
    if (hours < 1 || hours > 12) return null;
    if (localized[1] === "下午" || localized[1] === "晚上" || localized[1] === "中午") {
      hours = (hours % 12) + 12;
    } else {
      hours %= 12;
    }
  } else if (english) {
    hours = Number(english[1]);
    minutes = Number(english[2]);
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (english[3].toLowerCase() === "pm" ? 12 : 0);
  } else if (compact || clock) {
    const match = compact ?? clock;
    hours = Number(match?.[1]);
    minutes = Number(match?.[2]);
  } else {
    return null;
  }

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null;
}

function formatPlanTime(value: string): string {
  const minutes = parsePlanTime(value);
  if (minutes == null) return value.trim();
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function comparePlanStopTimes(left: PlanStop, right: PlanStop): number {
  const leftMinutes = parsePlanTime(left.startTime) ?? Number.POSITIVE_INFINITY;
  const rightMinutes = parsePlanTime(right.startTime) ?? Number.POSITIVE_INFINITY;
  return leftMinutes - rightMinutes;
}

function sortPlanStops(stops: PlanStop[]): PlanStop[] {
  return [...stops].sort((left, right) => {
    const dayDifference = Math.max(1, left.day || 1) - Math.max(1, right.day || 1);
    return dayDifference || comparePlanStopTimes(left, right);
  });
}

const REGION_LEVELS: { level: RegionLevel; label: string; unit: string }[] = [
  { level: "country", label: "国家", unit: "个国家" },
  { level: "province", label: "省/州", unit: "个省" },
  { level: "city", label: "市", unit: "个市" },
  { level: "county", label: "县", unit: "个区县" },
];

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const uid = () => Math.random().toString(36).slice(2, 10);

function readMapLayerSelection(): MapLayerId {
  if (typeof window === "undefined") return "auto";
  try {
    const saved = window.localStorage.getItem(MAP_LAYER_SELECTION_KEY);
    return MAP_LAYER_OPTIONS.some((option) => option.id === saved) ? (saved as MapLayerId) : "auto";
  } catch {
    return "auto";
  }
}

function availableTravelCategories(configured: string[], notes: TravelNote[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const category of [
    ...configured,
    ...notes.map((note) => travelCategoryLabel(note.category)),
  ]) {
    const label = travelCategoryLabel(category);
    if (!seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function confirmDelete(message: string): Promise<boolean> {
  try {
    if (isTauriRuntime()) return await tauriConfirm(message, { title: "删除", kind: "warning" });
  } catch {
    /* fall through */
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

const emptyNoteInput = (): NoteInput => ({
  title: "",
  category: "",
  lat: null,
  lng: null,
  address: "",
  rating: 0,
  date: localToday(),
});

// A list card's preview: the note's first image (as a displayable URL) plus a
// short plain-text snippet of its body. Cached by note id + updatedAt so it only
// reloads when the note changes.
const IMG_RE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/;

interface CardPreview {
  image: string | null;
  snippet: string;
}
const previewCache = new Map<string, CardPreview>();

/** Strip Markdown to a one-line plain-text snippet for the card body. */
function plainSnippet(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[#>*`_~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function loadCardPreview(noteId: string): Promise<CardPreview> {
  const markdown = await readNote(noteId);
  let image: string | null = null;
  const match = IMG_RE.exec(markdown);
  if (match) {
    const url = match[1].trim();
    if (/^data:/.test(url) || /^https?:\/\//.test(url)) {
      image = url;
    } else {
      const [dataUrl] = await readNoteAssets(noteId, [url]);
      image = dataUrl || null;
    }
  }
  return { image, snippet: plainSnippet(markdown) };
}

function useCardPreview(
  noteId: string,
  updatedAt: number,
): { loaded: boolean; preview: CardPreview } {
  const key = `${noteId}:${updatedAt}`;
  const [state, setState] = useState<{ loaded: boolean; preview: CardPreview }>(() =>
    previewCache.has(key)
      ? { loaded: true, preview: previewCache.get(key)! }
      : { loaded: false, preview: { image: null, snippet: "" } },
  );
  useEffect(() => {
    let active = true;
    void (async () => {
      let result: CardPreview;
      if (previewCache.has(key)) {
        result = previewCache.get(key)!;
      } else {
        try {
          result = await loadCardPreview(noteId);
        } catch {
          result = { image: null, snippet: "" };
        }
        previewCache.set(key, result);
      }
      if (active) setState({ loaded: true, preview: result });
    })();
    return () => {
      active = false;
    };
  }, [key, noteId]);
  return state;
}

// Placeholder when a note has no image: a stable "random" travel emoji per note
// (hashed from the id so it never changes between renders).
const TRAVEL_EMOJIS = [
  "🏔️",
  "🏖️",
  "🗺️",
  "🧭",
  "🏕️",
  "🌄",
  "🏝️",
  "⛩️",
  "🌅",
  "🏞️",
  "🚞",
  "🗿",
  "🎡",
  "🏛️",
  "🌋",
  "⛰️",
  "🛶",
  "🏙️",
  "🚠",
  "🏰",
];

function emojiForNote(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TRAVEL_EMOJIS[hash % TRAVEL_EMOJIS.length];
}

// ── Collection: the travel-notes library (left column) ─────────────────────────
export function TravelCollection({
  accent,
  travel,
  selectedId,
  onSelect,
}: {
  accent: Accent;
  travel: TravelData;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [menu, setMenu] = useState<{ note: TravelNote; x: number; y: number } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(() => new Set());
  const [minimumRating, setMinimumRating] = useState(0);

  const categories = useMemo(
    () => availableTravelCategories(travel.categories, travel.notes),
    [travel.categories, travel.notes],
  );
  const activeFilterCount = (selectedCategories.size > 0 ? 1 : 0) + (minimumRating > 0 ? 1 : 0);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return travel.notes.filter((note) => {
      const matchesQuery =
        !q ||
        [note.title, note.category, note.address].some((field) =>
          field.toLocaleLowerCase().includes(q),
        );
      const matchesCategory =
        selectedCategories.size === 0 || selectedCategories.has(travelCategoryLabel(note.category));
      const matchesRating = minimumRating === 0 || note.rating >= minimumRating;
      return matchesQuery && matchesCategory && matchesRating;
    });
  }, [travel.notes, query, selectedCategories, minimumRating]);

  const toggleCategoryFilter = useCallback((category: string) => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const createNote = useCallback(async () => {
    const created = await travel.createNote(emptyNoteInput());
    if (created) onSelect(created.id);
  }, [travel, onSelect]);

  const deleteNote = useCallback(
    async (note: TravelNote) => {
      const ok = await confirmDelete(
        `确定删除旅行笔记「${note.title || "未命名旅行"}」吗？此操作无法撤销。`,
      );
      if (!ok) return;
      await travel.deleteNote(note.id);
      if (note.id === selectedId) onSelect(null);
    },
    [travel, selectedId, onSelect],
  );

  return (
    <View style={{ flex: 1, minHeight: 0 } as ViewStyle}>
      <View style={styles.tools}>
        <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
          <RiSearch2Line
            color={searchFocused ? accent.accentText : theme.t.textTertiary}
            size={15}
          />
          <TextInput
            accessibilityLabel="搜索旅行笔记"
            onBlur={() => setSearchFocused(false)}
            onChangeText={setQuery}
            onFocus={() => setSearchFocused(true)}
            placeholder="搜索地点、分类…"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.searchInput}
            value={query}
          />
        </View>
        <Pressable
          accessibilityLabel="筛选旅行笔记"
          accessibilityRole="button"
          accessibilityState={{ expanded: showFilters }}
          onPress={() => setShowFilters((value) => !value)}
          style={({ hovered, pressed }: PressState) => [
            styles.filterButton,
            motion,
            (showFilters || activeFilterCount > 0) && styles.filterButtonActive,
            hovered && !showFilters && styles.filterButtonHover,
            pressed && ({ opacity: 0.82 } as ViewStyle),
          ]}
        >
          <RiFilter3Line
            color={showFilters || activeFilterCount > 0 ? accent.accentText : theme.t.textTertiary}
            size={17}
          />
          {activeFilterCount > 0 ? (
            <View style={styles.filterCountBadge}>
              <Text style={styles.filterCountText}>{activeFilterCount}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityLabel="新建旅行笔记"
          accessibilityRole="button"
          onPress={() => void createNote()}
          style={({ hovered, pressed }: PressState) => [
            styles.addButton,
            motion,
            hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
            pressed && ({ opacity: 0.9 } as ViewStyle),
          ]}
        >
          <RiAddLine color={accent.accentText} size={18} />
        </Pressable>
      </View>

      {showFilters ? (
        <TravelFilterPanel
          accent={accent}
          categories={categories}
          minimumRating={minimumRating}
          resultCount={filtered.length}
          selectedCategories={selectedCategories}
          styles={styles}
          onClear={() => {
            setSelectedCategories(new Set());
            setMinimumRating(0);
          }}
          onMinimumRatingChange={setMinimumRating}
          onToggleCategory={toggleCategoryFilter}
        />
      ) : null}

      {travel.notes.length === 0 ? (
        <View style={styles.emptyCollection}>
          <EmptyIllustration color={theme.t.textPrimary} section="travel" size={72} />
          <Text style={styles.emptyText}>还没有旅行笔记{"\n"}点击右上角 + 记录第一段旅程</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyCollection}>
          <Text style={styles.emptyText}>没有符合当前搜索与筛选条件的旅行笔记</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          style={{ flex: 1, minHeight: 0 } as ViewStyle}
        >
          {filtered.map((note) => (
            <NoteCard
              active={note.id === selectedId}
              key={note.id}
              note={note}
              onContextMenu={(x, y) => setMenu({ note, x, y })}
              onDelete={() => void deleteNote(note)}
              onPress={() => onSelect(note.id)}
              styles={styles}
              theme={theme}
            />
          ))}
        </ScrollView>
      )}

      {menu ? (
        <TravelNoteContextMenu
          accent={accent}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onDelete={() => {
            const note = menu.note;
            setMenu(null);
            void deleteNote(note);
          }}
          onOpen={() => {
            onSelect(menu.note.id);
            setMenu(null);
          }}
          onReveal={() => {
            const id = menu.note.id;
            setMenu(null);
            void revealTravel(id);
          }}
        />
      ) : null}
    </View>
  );
}

function TravelFilterPanel({
  accent,
  categories,
  minimumRating,
  resultCount,
  selectedCategories,
  styles,
  onClear,
  onMinimumRatingChange,
  onToggleCategory,
}: {
  accent: Accent;
  categories: string[];
  minimumRating: number;
  resultCount: number;
  selectedCategories: Set<string>;
  styles: TravelStyles;
  onClear: () => void;
  onMinimumRatingChange: (rating: number) => void;
  onToggleCategory: (category: string) => void;
}) {
  const active = selectedCategories.size > 0 || minimumRating > 0;

  return (
    <View style={styles.filterPanel}>
      <View style={styles.filterPanelHeader}>
        <Text style={styles.filterPanelTitle}>筛选旅行笔记</Text>
        <Text style={styles.filterResultCount}>{resultCount} 条</Text>
        {active ? (
          <Pressable accessibilityRole="button" onPress={onClear} style={styles.filterClearButton}>
            <Text style={styles.filterClearText}>清除</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.filterLabel}>分类（可多选）</Text>
      <View style={styles.filterChipWrap}>
        {categories.map((category) => {
          const selected = selectedCategories.has(category);
          const color = travelCategoryColor(category);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={category}
              onPress={() => onToggleCategory(category)}
              style={({ hovered }: PressState) => [
                styles.filterChip,
                motion,
                selected &&
                  ({ backgroundColor: `${color}1A`, borderColor: `${color}66` } as ViewStyle),
                !selected && hovered && styles.filterChipHover,
              ]}
            >
              <View style={[styles.filterCategoryDot, { backgroundColor: color }]} />
              <Text style={[styles.filterChipText, selected && { color, fontWeight: "700" }]}>
                {category}
              </Text>
              {selected ? <RiCheckLine color={color} size={13} /> : null}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.filterLabel}>最低评分</Text>
      <View style={styles.ratingFilterRow}>
        {[0, 1, 2, 3, 4, 5].map((rating) => {
          const selected = minimumRating === rating;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={rating}
              onPress={() => onMinimumRatingChange(rating)}
              style={({ hovered }: PressState) => [
                styles.ratingFilterButton,
                motion,
                selected && styles.ratingFilterButtonActive,
                !selected && hovered && styles.filterChipHover,
              ]}
            >
              <Text
                style={[
                  styles.ratingFilterText,
                  selected && { color: accent.accentText, fontWeight: "700" },
                ]}
              >
                {rating === 0 ? "不限" : `${rating}★+`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function TravelNoteContextMenu({
  accent,
  x,
  y,
  onOpen,
  onReveal,
  onDelete,
  onClose,
}: {
  accent: Accent;
  x: number;
  y: number;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = theme;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 8 - rect.width))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 8 - rect.height))}px`;
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: { label: string; icon: ReactNode; onPress: () => void; danger?: boolean }[] = [
    {
      label: "打开",
      icon: <RiExternalLinkLine color={t.textSecondary} size={15} />,
      onPress: onOpen,
    },
    ...(isTauriRuntime()
      ? [
          {
            label: "在访达中显示",
            icon: <RiFolderOpenLine color={t.textSecondary} size={15} />,
            onPress: onReveal,
          },
        ]
      : []),
    {
      label: "删除",
      icon: <RiDeleteBinLine color={t.errorText} size={15} />,
      onPress: onDelete,
      danger: true,
    },
  ];

  return createPortal(
    <div
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 2000 }}
    >
      <div
        ref={ref}
        role="menu"
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          left: x,
          top: y,
          minWidth: 160,
          padding: 6,
          background: t.cardSurface,
          border: `1px solid ${t.separator}`,
          borderRadius: 12,
          boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
          fontFamily: "inherit",
        }}
      >
        {rows.map((row) => (
          <button
            key={row.label}
            role="menuitem"
            type="button"
            onClick={row.onPress}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = row.danger
                ? "rgba(178,77,77,0.10)"
                : `rgba(${accent.rgb},0.12)`;
            }}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              border: "none",
              background: "transparent",
              padding: "7px 10px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              lineHeight: 1.2,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              color: row.danger ? t.errorText : t.textPrimary,
              transition: "background-color 120ms ease",
            }}
          >
            <span style={{ display: "inline-flex", width: 18, justifyContent: "center" }}>
              {row.icon}
            </span>
            {row.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function NoteCard({
  active,
  note,
  onContextMenu,
  onPress,
  onDelete,
  styles,
  theme,
}: {
  active: boolean;
  note: TravelNote;
  onContextMenu: (x: number, y: number) => void;
  onPress: () => void;
  onDelete: () => void;
  styles: TravelStyles;
  theme: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  // Measure the text block's height and make the thumbnail a square of that side,
  // so the image is always a rounded square exactly as tall as the card content.
  const [thumbSize, setThumbSize] = useState(58);
  const { preview } = useCardPreview(note.id, note.updatedAt);
  const categoryColor = travelCategoryColor(note.category);
  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ width: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={onPress}
        style={[
          styles.card,
          motion,
          hovered && !active && styles.cardHover,
          active && styles.cardActive,
        ]}
      >
        <NoteThumbnail image={preview.image} noteId={note.id} size={thumbSize} styles={styles} />
        <View
          style={styles.cardBody}
          onLayout={(event) => {
            const h = Math.round(event.nativeEvent.layout.height);
            if (h > 0 && h !== thumbSize) setThumbSize(h);
          }}
        >
          <View style={styles.cardTitleRow}>
            <Text numberOfLines={1} style={styles.cardTitle}>
              {note.title}
            </Text>
            {/* Always laid out (only opacity toggles) so hover never reflows the card. */}
            <div
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              style={{
                display: "flex",
                opacity: hovered ? 1 : 0,
                pointerEvents: hovered ? "auto" : "none",
                transition: "opacity 120ms ease",
              }}
            >
              <View style={styles.cardDelete}>
                <RiDeleteBinLine color={theme.t.textTertiary} size={15} />
              </View>
            </div>
          </View>

          <View style={styles.cardSnippetRow}>
            <Text numberOfLines={1} style={styles.cardSnippet}>
              {preview.snippet || "还没有正文，点开写点什么…"}
            </Text>
            {note.category ? (
              <View
                style={[
                  styles.cardCategory,
                  { backgroundColor: `${categoryColor}20` } as ViewStyle,
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.cardCategoryText, { color: categoryColor } as ViewStyle]}
                >
                  #{note.category}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.cardMetaRow}>
            <StarChip rating={note.rating} />
            <View style={{ flex: 1 }} />
            <Text style={styles.cardDate}>{note.date}</Text>
          </View>
        </View>
      </Pressable>
    </div>
  );
}

/**
 * The list card's thumbnail: a note's first image, or an emoji placeholder. A
 * rounded square whose side (`size`) is measured from the card's text height, so
 * it's always a true square exactly as tall as the card content.
 */
function NoteThumbnail({
  image,
  noteId,
  size,
  styles,
}: {
  image: string | null;
  noteId: string;
  size: number;
  styles: TravelStyles;
}) {
  return (
    <View style={[styles.thumb, { width: size, height: size } as ViewStyle]}>
      {image ? (
        <img
          alt=""
          src={image}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <Text style={styles.thumbEmoji}>{emojiForNote(noteId)}</Text>
      )}
    </View>
  );
}

// ── Main column: the map with 地图 / 旅行轨迹 / 旅行规划 ─────────────────────────
export function TravelMainColumn({
  accent,
  travel,
  selectedId,
  onSelect,
}: {
  accent: Accent;
  travel: TravelData;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [view, setView] = useState<TravelView>("map");
  const [showFullNote, setShowFullNote] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const [mapLayer, setMapLayer] = useState<MapLayerId>(readMapLayerSelection);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [planPreview, setPlanPreview] = useState<TravelPlan | null>(null);
  const [planningDay, setPlanningDay] = useState<PlanDayFilter>("all");
  const [regionLevel, setRegionLevel] = useState<RegionLevel>("province");
  const [regions, setRegions] = useState<RegionCollection | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const mapHandle = useRef<MapHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const lastMapCenter = useRef({ lat: 35, lng: 105 });
  const [planningMapInitial, setPlanningMapInitial] = useState({ lat: 35, lng: 105, zoom: 4 });
  // The current map center, read lazily when a location picker opens (kept out of
  // render so it never triggers re-renders on pan).
  const getMapCenter = useCallback(() => {
    try {
      const center = mapHandle.current?.getCenter();
      if (center) lastMapCenter.current = center;
    } catch {
      // The map may already be tearing down while switching to planning.
    }
    return lastMapCenter.current;
  }, []);
  const changeView = useCallback(
    (next: TravelView) => {
      if (next === "planning") {
        const center = getMapCenter();
        setPlanningMapInitial({ ...center, zoom: 4 });
        mapHandle.current = null;
        setMapReady(false);
        setShowOffline(false);
      }
      setView(next);
    },
    [getMapCenter],
  );

  const basemap = travel.settings?.basemap ?? "online";
  const effectiveMapLayer =
    basemap !== "online" && (mapLayer === "satellite" || mapLayer === "terrain")
      ? "auto"
      : mapLayer;
  // A selected note shows as a docked panel over the current view — no dedicated
  // tab, no view switch (the panel just appears on top).
  const openNote = travel.findNote(selectedId);
  const noteExpanded = showFullNote && openNote != null;
  const storedActivePlan = travel.plans.find((plan) => plan.id === activePlanId) ?? null;
  const activePlan = planPreview?.id === activePlanId ? planPreview : storedActivePlan;

  // The planning workspace owns a dedicated map. Pins are numbered per day and
  // routes stay separated by day so "全程" can show several colored timelines
  // at once while D1 / D2 narrows both the map and the right-hand timeline.
  const planningMarkers = useMemo<MapMarker[]>(() => {
    if (!activePlan) return [];
    const days =
      planningDay === "all"
        ? Array.from(new Set(activePlan.stops.map((stop) => Math.max(1, stop.day || 1)))).sort(
            (a, b) => a - b,
          )
        : [planningDay];
    return days.flatMap((day) =>
      activePlan.stops
        .filter(
          (stop) => Math.max(1, stop.day || 1) === day && stop.lat != null && stop.lng != null,
        )
        .sort(comparePlanStopTimes)
        .map((stop, index) => ({
          id: stop.id,
          lat: stop.lat as number,
          lng: stop.lng as number,
          color: planDayColor(day),
          badge: `${day}.${index + 1}`,
        })),
    );
  }, [activePlan, planningDay]);
  const planningRoutes = useMemo<MapRoute[]>(() => {
    if (!activePlan) return [];
    const days =
      planningDay === "all"
        ? Array.from(new Set(activePlan.stops.map((stop) => Math.max(1, stop.day || 1)))).sort(
            (a, b) => a - b,
          )
        : [planningDay];
    return days.flatMap((day) => {
      const coordinates = activePlan.stops
        .filter(
          (stop) => Math.max(1, stop.day || 1) === day && stop.lat != null && stop.lng != null,
        )
        .sort(comparePlanStopTimes)
        .map((stop) => [stop.lng as number, stop.lat as number] as [number, number]);
      return coordinates.length >= 2
        ? [{ id: `plan-day-${day}`, color: planDayColor(day), coordinates }]
        : [];
    });
  }, [activePlan, planningDay]);

  const notesWithCoords = useMemo(
    () => travel.notes.filter((note) => note.lat != null && note.lng != null),
    [travel.notes],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(MAP_LAYER_SELECTION_KEY, mapLayer);
    } catch {
      /* The selected layer remains active for this session when storage is unavailable. */
    }
  }, [mapLayer]);

  // Map and trajectory share the travel-note markers. Planning is a separate
  // full-page workspace and therefore never drives the main map instance.
  const markers: MapMarker[] = useMemo(() => {
    return notesWithCoords.map((note) => ({
      id: note.id,
      lat: note.lat as number,
      lng: note.lng as number,
      color: travelCategoryColor(note.category),
      rating: note.rating,
    }));
  }, [notesWithCoords]);
  const markerFitKey = useMemo(
    () =>
      markers
        .map((marker) => `${marker.id}:${marker.lat.toFixed(5)}:${marker.lng.toFixed(5)}`)
        .join("|"),
    [markers],
  );
  const planningMarkerFitKey = useMemo(
    () =>
      planningMarkers
        .map((marker) => `${marker.id}:${marker.lat.toFixed(5)}:${marker.lng.toFixed(5)}`)
        .join("|"),
    [planningMarkers],
  );

  // Fit the camera to what the current view shows (on view change / first ready).
  useEffect(() => {
    if (!mapReady || view === "planning") return;
    const points = markers.map((m) => ({ lat: m.lat, lng: m.lng }));
    if (points.length > 0) {
      mapHandle.current?.fit(points, 96);
    }
    // Only refit on view switch or when the map becomes ready — not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, mapReady, markerFitKey]);

  useEffect(() => {
    if (!mapReady || view !== "planning" || planningMarkers.length === 0) return;
    mapHandle.current?.fit(
      planningMarkers.map((marker) => ({ lat: marker.lat, lng: marker.lng })),
      72,
    );
  }, [view, mapReady, planningMarkerFitKey, planningMarkers]);

  // Compute the "lit-up" regions for the trajectory view (async: fetches admin
  // boundaries + point-in-polygon). Runs off an async IIFE so no setState fires
  // synchronously in the effect body.
  useEffect(() => {
    if (view !== "trajectory") return;
    const points = notesWithCoords.map((note) => ({
      lat: note.lat as number,
      lng: note.lng as number,
    }));
    const controller = new AbortController();
    let active = true;
    void (async () => {
      if (points.length === 0) {
        if (active) {
          setRegions(null);
          setRegionsError(null);
        }
        return;
      }
      if (active) {
        setRegionsLoading(true);
        setRegionsError(null);
      }
      try {
        const fc = await litRegions(points, regionLevel, controller.signal);
        if (active) setRegions(fc);
      } catch (err) {
        if (active && (err as Error).name !== "AbortError") {
          setRegionsError("无法加载行政边界（需要联网）");
          setRegions(null);
        }
      } finally {
        if (active) setRegionsLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [view, regionLevel, notesWithCoords]);

  const litCount = regions?.features.length ?? 0;
  const levelMeta = REGION_LEVELS.find((entry) => entry.level === regionLevel) ?? REGION_LEVELS[1];

  const onMarkerClick = (id: string) => {
    onSelect(id);
  };
  const selectPlan = (id: string | null) => {
    setActivePlanId(id);
    setPlanningDay("all");
    if (id == null) setPlanPreview(null);
    else {
      const nextPlan = travel.plans.find((plan) => plan.id === id);
      if (nextPlan) setPlanPreview(nextPlan);
    }
  };
  const viewSwitcher = (
    <View style={styles.segment}>
      <SegmentButton
        accent={accent}
        active={view === "map"}
        icon={RiMap2Line}
        label="地图"
        onPress={() => changeView("map")}
        styles={styles}
        theme={theme}
      />
      <SegmentButton
        accent={accent}
        active={view === "trajectory"}
        icon={RiRoadMapLine}
        label="旅行轨迹"
        onPress={() => changeView("trajectory")}
        styles={styles}
        theme={theme}
      />
      <SegmentButton
        accent={accent}
        active={view === "planning"}
        icon={RiCalendarTodoLine}
        label="旅行规划"
        onPress={() => changeView("planning")}
        styles={styles}
        theme={theme}
      />
    </View>
  );

  return (
    <View style={styles.mainRoot}>
      {view === "planning" ? (
        <View
          pointerEvents={noteExpanded ? "none" : "auto"}
          style={[styles.planningPage, noteExpanded && styles.mapLayerHidden]}
        >
          <View style={styles.planningWorkspace}>
            <View style={styles.planningMapPane}>
              <MapView
                accentRgb={accent.rgb}
                basemap={basemap}
                initial={planningMapInitial}
                mapLayer={effectiveMapLayer}
                markers={planningMarkers}
                onReady={(handle) => {
                  mapHandle.current = handle;
                  setMapReady(true);
                }}
                routeLines={planningRoutes}
              />

              <View pointerEvents="box-none" style={styles.planningViewSwitcher}>
                {viewSwitcher}
              </View>

              <View pointerEvents="box-none" style={styles.planningMapControls}>
                <Pressable
                  accessibilityLabel="地图来源与离线地图"
                  accessibilityRole="button"
                  onPress={() => setShowOffline(true)}
                  style={({ hovered }: PressState) => [
                    styles.mapChipButton,
                    motion,
                    hovered && styles.mapChipButtonHover,
                  ]}
                >
                  <RiGlobalLine color={theme.t.textSecondary} size={16} />
                  <Text style={styles.mapChipText}>
                    {basemap === "online" ? "在线地图" : basemap}
                  </Text>
                </Pressable>
                <MapLayersControl
                  accent={accent}
                  basemap={basemap}
                  value={effectiveMapLayer}
                  styles={styles}
                  theme={theme}
                  onChange={setMapLayer}
                />
              </View>

              {planningMarkers.length === 0 ? (
                <View pointerEvents="none" style={styles.planningMapEmpty}>
                  <View style={styles.planningMapEmptyCard}>
                    <RiMapPin2Line color={theme.t.textTertiary} size={18} />
                    <Text style={styles.planningMapEmptyText}>
                      {activePlan
                        ? "在右侧给地点选择位置后，会显示在规划地图上"
                        : "从右侧选择或新建一个行程"}
                    </Text>
                  </View>
                </View>
              ) : null}

              {showOffline ? (
                <OfflineMaps
                  accent={accent}
                  basemap={basemap}
                  maps={travel.maps}
                  onChanged={() => void travel.refreshMaps()}
                  onClose={() => setShowOffline(false)}
                  onSelectBasemap={(next) => void travel.setBasemap(next)}
                />
              ) : null}
            </View>

            <View style={styles.planningTimelinePane}>
              <PlanningPanel
                accent={accent}
                activePlan={activePlan}
                activeDay={planningDay}
                getMapCenter={getMapCenter}
                basemap={basemap}
                onActiveDayChange={setPlanningDay}
                onPreviewPlan={setPlanPreview}
                onSelectPlan={selectPlan}
                styles={styles}
                theme={theme}
                travel={travel}
              />
            </View>
          </View>
        </View>
      ) : (
        <View
          pointerEvents={noteExpanded ? "none" : "auto"}
          style={[styles.mapLayer, noteExpanded && styles.mapLayerHidden]}
        >
          <MapView
            accentRgb={accent.rgb}
            basemap={basemap}
            cluster
            mapLayer={effectiveMapLayer}
            markers={markers}
            onMarkerClick={onMarkerClick}
            onReady={(handle) => {
              mapHandle.current = handle;
              setMapReady(true);
            }}
            regions={view === "trajectory" ? regions : null}
            selectedId={selectedId}
          />

          {/* Floating controls (transparent to the map except on the chrome itself) */}
          <View pointerEvents="box-none" style={styles.overlayTop}>
            <View pointerEvents="box-none" style={styles.centerControls}>
              {viewSwitcher}

              {view === "trajectory" ? (
                <View style={styles.levelSegment}>
                  {REGION_LEVELS.map((entry) => {
                    const active = regionLevel === entry.level;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        key={entry.level}
                        onPress={() => setRegionLevel(entry.level)}
                        style={({ hovered }: PressState) => [
                          styles.levelButton,
                          motion,
                          active && styles.segmentButtonActive,
                          !active &&
                            hovered &&
                            ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                        ]}
                      >
                        <Text style={[styles.levelText, active && { color: accent.accentText }]}>
                          {entry.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>

            <View pointerEvents="box-none" style={styles.overlayRight}>
              <Pressable
                accessibilityLabel="地图来源与离线地图"
                accessibilityRole="button"
                onPress={() => setShowOffline(true)}
                style={({ hovered }: PressState) => [
                  styles.mapChipButton,
                  motion,
                  hovered && styles.mapChipButtonHover,
                ]}
              >
                <RiGlobalLine color={theme.t.textSecondary} size={16} />
                <Text style={styles.mapChipText}>
                  {basemap === "online" ? "在线地图" : basemap}
                </Text>
              </Pressable>
              <MapLayersControl
                accent={accent}
                basemap={basemap}
                value={effectiveMapLayer}
                styles={styles}
                theme={theme}
                onChange={setMapLayer}
              />
            </View>
          </View>

          {/* Trajectory: a "lit-up" count chip along the bottom. */}
          {view === "trajectory" ? (
            <View pointerEvents="box-none" style={styles.trajectoryFoot}>
              <View style={styles.litChip}>
                <RiRoadMapLine color={accent.accentText} size={14} />
                <Text style={styles.litChipText}>
                  {regionsError
                    ? regionsError
                    : regionsLoading
                      ? "正在点亮足迹…"
                      : notesWithCoords.length === 0
                        ? "给旅行笔记添加坐标即可点亮地图"
                        : `已点亮 ${litCount} ${levelMeta.unit}`}
                </Text>
              </View>
            </View>
          ) : null}

          {showOffline ? (
            <OfflineMaps
              accent={accent}
              basemap={basemap}
              maps={travel.maps}
              onChanged={() => void travel.refreshMaps()}
              onClose={() => setShowOffline(false)}
              onSelectBasemap={(next) => void travel.setBasemap(next)}
            />
          ) : null}
        </View>
      )}

      {/* The transparent dismiss layer covers only the main column, so clicking
          another note in the collection still switches directly to that note. */}
      {openNote && !noteExpanded ? (
        <Pressable
          accessibilityLabel="关闭旅行笔记详情"
          accessibilityRole="button"
          onPress={() => {
            setShowFullNote(false);
            onSelect(null);
          }}
          style={styles.noteDismissLayer}
        />
      ) : null}

      {/* A selected note docks over the active view, or fills this column in expanded mode. */}
      {openNote ? (
        <TravelNoteEditor
          accent={accent}
          basemap={basemap}
          categories={travel.categories}
          expanded={noteExpanded}
          getMapCenter={getMapCenter}
          key={openNote.id}
          note={openNote}
          onClose={() => {
            setShowFullNote(false);
            onSelect(null);
          }}
          onDelete={(id) => {
            void travel.deleteNote(id);
            setShowFullNote(false);
            onSelect(null);
          }}
          onAddCategory={travel.addCategory}
          onOpenFull={() => setShowFullNote(true)}
          onSaveMeta={travel.updateNote}
        />
      ) : null}
    </View>
  );
}

function SegmentButton({
  accent,
  active,
  icon: Icon,
  label,
  onPress,
  styles,
  theme,
}: {
  accent: Accent;
  active: boolean;
  icon: typeof RiMap2Line;
  label: string;
  onPress: () => void;
  styles: TravelStyles;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.segmentButton,
        motion,
        active && styles.segmentButtonActive,
        !active && hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
      ]}
    >
      <Icon color={active ? accent.accentText : theme.t.textTertiary} size={15} />
      <Text style={[styles.segmentText, active && { color: accent.accentText }]}>{label}</Text>
    </Pressable>
  );
}

function MapLayersControl({
  accent,
  basemap,
  value,
  styles,
  theme,
  onChange,
}: {
  accent: Accent;
  basemap: string;
  value: MapLayerId;
  styles: TravelStyles;
  theme: Theme;
  onChange: (value: MapLayerId) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeOption =
    MAP_LAYER_OPTIONS.find((option) => option.id === value) ?? MAP_LAYER_OPTIONS[0];
  const online = basemap === "online";

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ display: "flex", position: "relative" }}>
      <Pressable
        accessibilityLabel={`地图图层：${activeOption.label}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ hovered }: PressState) => [
          styles.mapChipButton,
          motion,
          open && styles.mapChipButtonActive,
          hovered && styles.mapChipButtonHover,
        ]}
      >
        <RiStackLine color={open ? accent.accentText : theme.t.textSecondary} size={16} />
        <Text style={[styles.mapChipText, open && { color: accent.accentText }]}>图层</Text>
        <Text style={styles.layerActiveText}>{activeOption.label}</Text>
      </Pressable>

      {open ? (
        <View style={styles.layerMenu}>
          <View style={styles.layerMenuHeader}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.layerMenuTitle}>地图图层</Text>
              <Text style={styles.layerMenuSubtitle}>选择地图类型；旅行笔记标记会始终保留</Text>
            </View>
          </View>

          <View style={styles.layerOptionGrid}>
            {MAP_LAYER_OPTIONS.map((option) => {
              const active = option.id === value;
              const disabled = Boolean(option.onlineOnly && !online);
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled, selected: active }}
                  disabled={disabled}
                  key={option.id}
                  onPress={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  style={({ hovered }: PressState) => [
                    styles.layerOption,
                    motion,
                    active && styles.layerOptionActive,
                    hovered && !active && !disabled && styles.filterChipHover,
                    disabled && styles.layerOptionDisabled,
                  ]}
                >
                  <View
                    style={[
                      styles.layerOptionPreview,
                      { backgroundColor: option.preview.background },
                    ]}
                  >
                    <View
                      style={[styles.layerPreviewWater, { backgroundColor: option.preview.water }]}
                    />
                    <View
                      style={[styles.layerPreviewRoad, { backgroundColor: option.preview.detail }]}
                    />
                  </View>
                  <View style={styles.layerOptionCopy}>
                    <View style={styles.layerOptionTitleRow}>
                      <Text
                        style={[styles.layerOptionTitle, active && { color: accent.accentText }]}
                      >
                        {option.label}
                      </Text>
                      {active ? <RiCheckLine color={accent.accentText} size={13} /> : null}
                    </View>
                    <Text numberOfLines={2} style={styles.layerOptionDescription}>
                      {disabled ? "仅在线地图可用" : option.description}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.trafficLayerRow}>
            <View style={styles.trafficLayerIcon}>
              <RiTrafficLightLine color={theme.t.textTertiary} size={16} />
            </View>
            <View style={styles.layerOptionCopy}>
              <Text style={styles.trafficLayerTitle}>实时路况</Text>
              <Text style={styles.layerOptionDescription}>需要接入实时路况数据服务</Text>
            </View>
            <Text style={styles.trafficLayerStatus}>暂不可用</Text>
          </View>
        </View>
      ) : null}
    </div>
  );
}

function PlanTimeInput({
  label,
  onChange,
  primary,
  theme,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  primary: boolean;
  theme: Theme;
  value: string;
}) {
  const displayValue = formatPlanTime(value);
  const [draft, setDraft] = useState(displayValue);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft("");
      if (value) onChange("");
      return;
    }

    const minutes = parsePlanTime(trimmed);
    if (minutes == null) {
      setDraft(displayValue);
      return;
    }

    const next = formatPlanTime(trimmed);
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <input
      aria-label={`${label}，24 小时制`}
      autoComplete="off"
      inputMode="numeric"
      maxLength={5}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(displayValue);
          event.currentTarget.blur();
        }
      }}
      placeholder="--:--"
      spellCheck={false}
      style={timeInputStyle(theme, primary)}
      title="24 小时制，例如 09:30 或 18:45"
      type="text"
      value={draft}
    />
  );
}

// ── Planning panel ─────────────────────────────────────────────────────────────
function PlanningPanel({
  accent,
  activePlan,
  activeDay,
  basemap,
  getMapCenter,
  onActiveDayChange,
  onPreviewPlan,
  onSelectPlan,
  styles,
  theme,
  travel,
}: {
  accent: Accent;
  activePlan: TravelPlan | null;
  activeDay: PlanDayFilter;
  basemap: string;
  getMapCenter: () => { lat: number; lng: number };
  onActiveDayChange: (day: PlanDayFilter) => void;
  onPreviewPlan: (plan: TravelPlan | null) => void;
  onSelectPlan: (id: string | null) => void;
  styles: TravelStyles;
  theme: Theme;
  travel: TravelData;
}) {
  const [draft, setDraft] = useState<TravelPlan | null>(activePlan);
  const [syncedPlanId, setSyncedPlanId] = useState<string | null>(activePlan?.id ?? null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(activePlan?.title ?? "");
  const [pickingStop, setPickingStop] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Reset the local draft only when a *different* plan is selected — not when the
  // same plan's object identity changes after a debounced save (which would
  // clobber edits made while the save was in flight). This render-time sync is
  // React's sanctioned "store info from previous renders" pattern.
  if ((activePlan?.id ?? null) !== syncedPlanId) {
    setSyncedPlanId(activePlan?.id ?? null);
    setDraft(activePlan);
    setEditingTitle(false);
    setTitleDraft(activePlan?.title ?? "");
  }

  const scheduleSave = useCallback(
    (next: TravelPlan) => {
      const normalized = {
        ...next,
        stops: sortPlanStops(
          next.stops.map((stop) => ({
            ...stop,
            startTime: formatPlanTime(stop.startTime),
            endTime: formatPlanTime(stop.endTime),
          })),
        ),
      };
      setDraft(normalized);
      onPreviewPlan(normalized);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void travel.savePlan(normalized), 500);
    },
    [onPreviewPlan, travel],
  );

  const createPlan = async () => {
    const created = await travel.createPlan({
      title: "",
      startDate: localToday(),
      endDate: "",
      notes: "",
      stops: [],
    });
    if (created) {
      onPreviewPlan(created);
      onSelectPlan(created.id);
    }
  };

  const removePlan = async (plan: TravelPlan) => {
    const ok = await confirmDelete(`确定删除行程「${plan.title || "未命名行程"}」吗？`);
    if (ok) {
      await travel.deletePlan(plan.id);
      onPreviewPlan(null);
      onSelectPlan(null);
    }
  };

  // Plan list (no plan selected).
  if (!draft) {
    return (
      <View style={styles.planPanel}>
        <View style={styles.planHeader}>
          <Text style={styles.planHeaderTitle}>旅行规划</Text>
          <Pressable
            accessibilityLabel="新建行程"
            accessibilityRole="button"
            onPress={() => void createPlan()}
            style={({ hovered }: PressState) => [
              styles.planAdd,
              motion,
              hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
            ]}
          >
            <RiAddLine color={accent.accentText} size={16} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.planListContent} style={{ minHeight: 0 }}>
          {travel.plans.length === 0 ? (
            <Text style={styles.planEmpty}>还没有行程。新建一个，按天安排地点与时间。</Text>
          ) : (
            travel.plans.map((plan) => (
              <Pressable
                accessibilityRole="button"
                key={plan.id}
                onPress={() => onSelectPlan(plan.id)}
                style={({ hovered }: PressState) => [
                  styles.planListItem,
                  motion,
                  hovered && { backgroundColor: theme.t.controlHover },
                ]}
              >
                <RiCalendarTodoLine color={accent.accentText} size={15} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={styles.planListTitle}>
                    {plan.title || "未命名行程"}
                  </Text>
                  <Text style={styles.planListMeta}>
                    {plan.stops.length} 个地点{plan.startDate ? ` · ${plan.startDate}` : ""}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  const updateStop = (id: string, change: Partial<PlanStop>) => {
    scheduleSave({
      ...draft,
      stops: draft.stops.map((stop) => (stop.id === id ? { ...stop, ...change } : stop)),
    });
  };
  const addStop = (requestedDay?: number) => {
    const day =
      requestedDay ??
      (activeDay === "all"
        ? draft.stops.reduce((max, stop) => Math.max(max, stop.day), 0) || 1
        : activeDay);
    scheduleSave({
      ...draft,
      stops: [
        ...draft.stops,
        {
          id: uid(),
          title: "",
          address: "",
          lat: null,
          lng: null,
          day,
          startTime: "",
          endTime: "",
          note: "",
          done: false,
        },
      ],
    });
  };
  const removeStop = (id: string) =>
    scheduleSave({ ...draft, stops: draft.stops.filter((stop) => stop.id !== id) });
  const beginTitleEdit = () => {
    setTitleDraft(draft.title);
    setEditingTitle(true);
  };
  const commitTitleEdit = () => {
    const title = titleDraft.trim() || "未命名行程";
    setEditingTitle(false);
    setTitleDraft(title);
    if (title !== draft.title) scheduleSave({ ...draft, title });
  };

  const pickStop = draft.stops.find((stop) => stop.id === pickingStop) ?? null;
  const days = Array.from({ length: planDayCount(draft) }, (_, index) => index + 1);
  const visibleDays = activeDay === "all" ? days : [activeDay];

  // Plan detail (a plan is selected).
  return (
    <View style={styles.planPanel}>
      <View style={styles.planHeader}>
        <View style={styles.planHeaderLeading}>
          <Pressable
            accessibilityLabel="返回行程列表"
            accessibilityRole="button"
            onPress={() => onSelectPlan(null)}
            style={({ hovered }: PressState) => [
              styles.planBack,
              hovered && { backgroundColor: theme.t.controlHover },
            ]}
          >
            <RiArrowLeftLine color={theme.t.textSecondary} size={16} />
          </Pressable>
          {editingTitle ? (
            <input
              aria-label="行程标题"
              autoFocus
              maxLength={120}
              onBlur={commitTitleEdit}
              onChange={(event) => setTitleDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setTitleDraft(draft.title);
                  setEditingTitle(false);
                }
              }}
              style={planHeaderTitleInputStyle(theme, accent)}
              value={titleDraft}
            />
          ) : (
            <div
              aria-label="行程标题，双击修改"
              onDoubleClick={beginTitleEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "F2") beginTitleEdit();
              }}
              role="button"
              style={{ cursor: "text", flex: 1, minWidth: 0 }}
              tabIndex={0}
              title="双击修改行程标题"
            >
              <Text numberOfLines={1} style={styles.planHeaderTitle}>
                {draft.title || "未命名行程"}
              </Text>
            </div>
          )}
        </View>
        <Pressable
          accessibilityLabel="删除行程"
          accessibilityRole="button"
          onPress={() => void removePlan(draft)}
          style={({ hovered }: PressState) => [
            styles.planBack,
            hovered && { backgroundColor: "rgba(178,77,77,0.10)" },
          ]}
        >
          <RiDeleteBinLine color={theme.t.errorText} size={15} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.planBody} style={{ minHeight: 0 }}>
        <View style={styles.planDates}>
          <input
            aria-label="开始日期"
            onChange={(event) => scheduleSave({ ...draft, startDate: event.target.value })}
            style={dateInputStyle(theme)}
            type="date"
            value={draft.startDate}
          />
          <Text style={{ color: theme.t.textTertiary, fontSize: 12 }}>→</Text>
          <input
            aria-label="结束日期"
            onChange={(event) => scheduleSave({ ...draft, endDate: event.target.value })}
            style={dateInputStyle(theme)}
            type="date"
            value={draft.endDate}
          />
        </View>

        <ScrollView
          contentContainerStyle={styles.planDayTabsContent}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.planDayTabs}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: activeDay === "all" }}
            onPress={() => onActiveDayChange("all")}
            style={({ hovered }: PressState) => [
              styles.planDayTab,
              activeDay === "all" && styles.planDayTabActive,
              hovered && activeDay !== "all" && styles.filterChipHover,
            ]}
          >
            <RiRoadMapLine
              color={activeDay === "all" ? accent.accentText : theme.t.textTertiary}
              size={13}
            />
            <Text
              style={[styles.planDayTabText, activeDay === "all" && styles.planDayTabTextActive]}
            >
              全程
            </Text>
          </Pressable>
          {days.map((day) => {
            const selected = activeDay === day;
            const color = planDayColor(day);
            return (
              <Pressable
                accessibilityLabel={`显示第 ${day} 天`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={day}
                onPress={() => onActiveDayChange(day)}
                style={({ hovered }: PressState) => [
                  styles.planDayTab,
                  selected && styles.planDayTabActive,
                  hovered && !selected && styles.filterChipHover,
                ]}
              >
                <View style={[styles.planDayDot, { backgroundColor: color }]} />
                <Text style={[styles.planDayTabText, selected && { color }]}>D{day}</Text>
                <Text style={styles.planDayTabDate}>{planDayDate(draft, day)}</Text>
              </Pressable>
            );
          })}
          <Pressable
            accessibilityLabel="新增一天"
            accessibilityRole="button"
            onPress={() => {
              const nextDay = days.length + 1;
              addStop(nextDay);
              onActiveDayChange(nextDay);
            }}
            style={({ hovered }: PressState) => [
              styles.planDayAdd,
              hovered && styles.filterChipHover,
            ]}
          >
            <RiAddLine color={accent.accentText} size={14} />
          </Pressable>
        </ScrollView>

        <View style={styles.planStopsHeader}>
          <View style={styles.planSectionHeading}>
            <RiTimeLine color={theme.t.textTertiary} size={13} />
            <Text style={styles.planSectionLabel}>
              {activeDay === "all" ? "全程" : `第 ${activeDay} 天`} ·{" "}
              {activeDay === "all"
                ? draft.stops.length
                : draft.stops.filter((stop) => (stop.day || 1) === activeDay).length}{" "}
              个地点
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => addStop(activeDay === "all" ? undefined : activeDay)}
            style={styles.planAddStop}
          >
            <RiAddLine color={accent.accentText} size={14} />
            <Text style={styles.planAddStopText}>添加地点</Text>
          </Pressable>
        </View>

        {visibleDays.map((day) => {
          const dayStops = draft.stops
            .filter((stop) => (stop.day || 1) === day)
            .sort(comparePlanStopTimes);
          const color = planDayColor(day);
          return (
            <View key={day} style={styles.planDaySection}>
              <View style={styles.planDayHeader}>
                <View style={[styles.planDayColorBar, { backgroundColor: color }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.planDayTitle, { color }]}>第 {day} 天</Text>
                  <Text style={styles.planDaySubtitle}>
                    {planDayDate(draft, day) || "未设置日期"} · {dayStops.length} 个地点
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel={`给第 ${day} 天添加地点`}
                  accessibilityRole="button"
                  onPress={() => addStop(day)}
                  style={({ hovered }: PressState) => [
                    styles.planDayHeaderAdd,
                    hovered && styles.filterChipHover,
                  ]}
                >
                  <RiAddLine color={color} size={14} />
                  <Text style={[styles.planDayHeaderAddText, { color }]}>地点</Text>
                </Pressable>
              </View>

              {dayStops.length === 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => addStop(day)}
                  style={styles.planDayEmpty}
                >
                  <Text style={styles.planDayEmptyText}>添加当天的第一个地点</Text>
                </Pressable>
              ) : (
                dayStops.map((stop, index) => (
                  <View key={stop.id} style={styles.timelineRow}>
                    <View style={styles.timelineTimeColumn}>
                      <PlanTimeInput
                        label="开始时间"
                        onChange={(startTime) => updateStop(stop.id, { startTime })}
                        primary
                        theme={theme}
                        value={stop.startTime}
                      />
                      <PlanTimeInput
                        label="结束时间"
                        onChange={(endTime) => updateStop(stop.id, { endTime })}
                        primary={false}
                        theme={theme}
                        value={stop.endTime}
                      />
                    </View>
                    <View style={styles.timelineRail}>
                      <View
                        style={[
                          styles.timelineDot,
                          {
                            backgroundColor: theme.t.cardSurface,
                            borderColor: color,
                          } as ViewStyle,
                        ]}
                      />
                      {index < dayStops.length - 1 ? (
                        <View style={[styles.timelineLine, { backgroundColor: color }]} />
                      ) : null}
                    </View>
                    <View style={[styles.stopCard, { borderLeftColor: color } as ViewStyle]}>
                      <View style={styles.stopTop}>
                        <Pressable
                          accessibilityLabel={stop.done ? "标记未完成" : "标记完成"}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: stop.done }}
                          onPress={() => updateStop(stop.id, { done: !stop.done })}
                          style={[
                            styles.stopCheck,
                            {
                              backgroundColor: stop.done ? color : "transparent",
                              borderColor: stop.done ? color : theme.t.controlBorder,
                            } as ViewStyle,
                          ]}
                        >
                          {stop.done ? <Text style={styles.stopCheckMark}>✓</Text> : null}
                        </Pressable>
                        <TextInput
                          accessibilityLabel="地点名称"
                          onChangeText={(title) => updateStop(stop.id, { title })}
                          placeholder="地点，例如 兵马俑"
                          placeholderTextColor={theme.t.textTertiary}
                          style={[
                            styles.stopTitle,
                            stop.done && {
                              textDecorationLine: "line-through",
                              color: theme.t.textTertiary,
                            },
                          ]}
                          value={stop.title}
                        />
                        <Pressable
                          accessibilityLabel="删除地点"
                          accessibilityRole="button"
                          onPress={() => removeStop(stop.id)}
                          style={({ hovered }: PressState) => [
                            styles.stopRemove,
                            hovered && { backgroundColor: "rgba(178,77,77,0.10)" },
                          ]}
                        >
                          <RiCloseLine color={theme.t.textTertiary} size={14} />
                        </Pressable>
                      </View>
                      <View style={styles.stopMetaRow}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            setPickingStop(stop.id);
                          }}
                          style={({ hovered }: PressState) => [
                            styles.stopLocation,
                            hovered && { backgroundColor: theme.t.controlHover },
                          ]}
                        >
                          {stop.lat != null ? (
                            <RiMapPin2Fill color={accent.accentText} size={13} />
                          ) : (
                            <RiMapPin2Line color={theme.t.textTertiary} size={13} />
                          )}
                          <Text numberOfLines={1} style={styles.stopLocationText}>
                            {stop.address ||
                              (stop.lat != null
                                ? `${stop.lat.toFixed(3)}, ${stop.lng?.toFixed(3)}`
                                : "选择位置")}
                          </Text>
                        </Pressable>
                        <View style={styles.dayBadge}>
                          <Text style={styles.dayBadgeLabel}>D</Text>
                          <TextInput
                            accessibilityLabel="第几天"
                            inputMode="numeric"
                            onChangeText={(value) =>
                              updateStop(stop.id, { day: Math.max(0, Number(value) || 0) })
                            }
                            style={styles.dayInput}
                            value={stop.day ? String(stop.day) : ""}
                          />
                        </View>
                      </View>
                    </View>
                  </View>
                ))
              )}
            </View>
          );
        })}
      </ScrollView>

      {pickStop ? (
        <LocationPicker
          accent={accent}
          basemap={basemap}
          initial={{ lat: pickStop.lat, lng: pickStop.lng, address: pickStop.address }}
          initialCenter={getMapCenter()}
          onCancel={() => setPickingStop(null)}
          onConfirm={(location) => {
            updateStop(pickStop.id, {
              lat: location.lat,
              lng: location.lng,
              address: location.address,
              title: pickStop.title || location.address,
            });
            setPickingStop(null);
          }}
        />
      ) : null}
    </View>
  );
}

function dateInputStyle(theme: Theme): React.CSSProperties {
  return {
    background: theme.t.cardSurface,
    border: `1px solid ${theme.t.controlBorder}`,
    borderRadius: 8,
    color: theme.t.textPrimary,
    flex: 1,
    fontFamily: "inherit",
    fontSize: 12,
    minWidth: 0,
    outline: "none",
    padding: "6px 8px",
  };
}

function planHeaderTitleInputStyle(theme: Theme, accent: Accent): React.CSSProperties {
  return {
    background: "transparent",
    border: 0,
    borderBottom: `1px solid ${accent.accentText}`,
    boxSizing: "border-box",
    color: theme.t.textPrimary,
    flex: 1,
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 700,
    minWidth: 0,
    outline: "none",
    padding: "3px 2px",
  };
}

function timeInputStyle(theme: Theme, primary: boolean): React.CSSProperties {
  return {
    appearance: "none",
    background: "transparent",
    border: 0,
    boxSizing: "border-box",
    color: primary ? theme.t.textPrimary : theme.t.textTertiary,
    fontFamily: "inherit",
    fontSize: primary ? 11.5 : 10.5,
    fontWeight: primary ? 650 : 500,
    lineHeight: 1.2,
    maxWidth: "100%",
    outline: "none",
    overflow: "hidden",
    padding: 0,
    textAlign: "right",
    width: "100%",
  };
}

type TravelStyles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // Collection
    tools: { alignItems: "center", flexDirection: "row", gap: 8, padding: 10 },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flex: 1,
      flexDirection: "row",
      gap: 8,
      height: 36,
      paddingHorizontal: 10,
    },
    searchBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    searchInput: { color: t.textPrimary, flex: 1, fontSize: 12.5, minWidth: 0, paddingVertical: 7 },
    filterButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      height: 36,
      justifyContent: "center",
      position: "relative",
      width: 36,
    },
    filterButtonActive: {
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.28)`,
    },
    filterButtonHover: { backgroundColor: t.controlHover },
    filterCountBadge: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderColor: t.collectionSolid,
      borderRadius: 999,
      borderWidth: 1.5,
      height: 15,
      justifyContent: "center",
      position: "absolute",
      right: -3,
      top: -3,
      width: 15,
    },
    filterCountText: { color: t.onAccent, fontSize: 8.5, fontWeight: "800", lineHeight: 11 },
    addButton: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderRadius: 9,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    filterPanel: {
      backgroundColor: t.cardSurface,
      borderColor: t.separatorStrong,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: "0 5px 16px rgba(20,28,40,0.08)",
      gap: 8,
      marginBottom: 4,
      marginHorizontal: 10,
      padding: 10,
    },
    filterPanelHeader: { alignItems: "center", flexDirection: "row", gap: 7 },
    filterPanelTitle: { color: t.textPrimary, flex: 1, fontSize: 12.5, fontWeight: "700" },
    filterResultCount: { color: t.textTertiary, fontSize: 10.5 },
    filterClearButton: {
      backgroundColor: accent.selectedFill,
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    filterClearText: { color: accent.accentText, fontSize: 10.5, fontWeight: "600" },
    filterLabel: { color: t.textTertiary, fontSize: 10.5, fontWeight: "700" },
    filterChipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
    filterChip: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 7,
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    filterChipHover: { backgroundColor: t.controlHover },
    filterCategoryDot: { borderRadius: 999, height: 7, width: 7 },
    filterChipText: { color: t.textSecondary, fontSize: 10.5, fontWeight: "600" },
    ratingFilterRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
    ratingFilterButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 7,
      borderWidth: 1,
      justifyContent: "center",
      minWidth: 38,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    ratingFilterButtonActive: {
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.30)`,
    },
    ratingFilterText: { color: t.textSecondary, fontSize: 10.5, fontWeight: "600" },
    emptyCollection: {
      alignItems: "center",
      flex: 1,
      gap: 12,
      justifyContent: "center",
      paddingBottom: 48,
      paddingHorizontal: 24,
    },
    emptyText: { color: t.textTertiary, fontSize: 12.5, lineHeight: 19, textAlign: "center" },
    // list paddingHorizontal (4) + card paddingLeft (6) = 10 = the search box's
    // left inset, so the thumbnail lines up with the search box while the highlight
    // extends wider (to 4px from the column edges).
    list: { gap: 6, paddingBottom: 16, paddingHorizontal: 4, paddingTop: 4 },
    card: {
      alignItems: "flex-start",
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: "row",
      paddingHorizontal: 6,
      paddingVertical: 10,
    },
    cardHover: { backgroundColor: t.controlHover },
    cardActive: {
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.28)`,
    },
    // A true rounded square (width = height = the card's text height, set inline),
    // with a clear gap before the text.
    thumb: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 12,
      flexGrow: 0,
      flexShrink: 0,
      justifyContent: "center",
      marginRight: 12,
      overflow: "hidden",
      position: "relative",
    } as ViewStyle,
    thumbEmoji: { fontSize: 26, lineHeight: 32 },
    cardBody: { flex: 1, gap: 4, minWidth: 0 },
    cardTitleRow: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 20 },
    cardTitle: { color: t.textPrimary, flex: 1, fontSize: 13.5, fontWeight: "600", minWidth: 0 },
    cardDelete: {
      alignItems: "center",
      borderRadius: 6,
      height: 20,
      justifyContent: "center",
      width: 22,
    },
    cardSnippetRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    cardSnippet: { color: t.textTertiary, flex: 1, fontSize: 11.5, lineHeight: 15, minWidth: 0 },
    cardCategory: {
      borderRadius: 6,
      flexShrink: 0,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    cardCategoryText: { fontSize: 11, fontWeight: "600" },
    cardMetaRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    cardDate: { color: t.textTertiary, fontSize: 11 },

    // Main / map
    mainRoot: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    mapLayer: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    mapLayerHidden: { opacity: 0 },
    noteDismissLayer: {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 10,
    },
    planningPage: {
      backgroundColor: t.mainSurface,
      flex: 1,
      minHeight: 0,
      overflow: "hidden",
    },
    planningWorkspace: {
      flex: 1,
      flexDirection: "row",
      minHeight: 0,
      overflow: "hidden",
    },
    planningMapPane: {
      borderRightColor: t.separator,
      borderRightWidth: 1,
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      position: "relative",
    },
    planningTimelinePane: {
      backgroundColor: t.mainSurface,
      maxWidth: "44%",
      minWidth: 380,
      overflow: "hidden",
      width: 480,
    },
    planningViewSwitcher: {
      left: 14,
      position: "absolute",
      top: 14,
      zIndex: 10,
    },
    planningMapControls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      position: "absolute",
      right: 14,
      top: 62,
      zIndex: 10,
    },
    planningMapEmpty: {
      alignItems: "center",
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 24,
      position: "absolute",
      right: 0,
      top: 0,
    },
    planningMapEmptyCard: {
      alignItems: "center",
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: "0 6px 20px rgba(16,24,36,0.12)",
      flexDirection: "row",
      gap: 8,
      maxWidth: 300,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    planningMapEmptyText: {
      color: t.textSecondary,
      flexShrink: 1,
      fontSize: 11.5,
      lineHeight: 17,
    },
    overlayTop: {
      alignItems: "flex-start",
      flexDirection: "row",
      justifyContent: "center",
      left: 0,
      paddingHorizontal: 16,
      paddingTop: 14,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 10,
    },
    centerControls: {
      alignItems: "center",
      gap: 8,
    },
    segment: {
      alignItems: "center",
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: "0 6px 20px rgba(16,24,36,0.14)",
      flexDirection: "row",
      gap: 2,
      padding: 4,
    },
    segmentButton: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 13,
      paddingVertical: 7,
    },
    segmentButtonActive: {
      backgroundColor: t.cardSurface,
      boxShadow: "0 1px 3px rgba(20,28,40,0.12)",
    },
    segmentText: { color: t.textTertiary, fontSize: 12.5, fontWeight: "600" },
    overlayRight: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      position: "absolute",
      right: 16,
      // The center segment is ~6px taller (outer padding + inner button padding),
      // so nudge the chips down ~3px to share its vertical center line.
      top: 17,
    },
    levelSegment: {
      alignItems: "center",
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 6px 20px rgba(16,24,36,0.14)",
      flexDirection: "row",
      gap: 2,
      padding: 3,
    },
    levelButton: {
      alignItems: "center",
      borderRadius: 8,
      justifyContent: "center",
      minWidth: 40,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    levelText: { color: t.textTertiary, fontSize: 12, fontWeight: "600" },
    mapChipButton: {
      alignItems: "center",
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      boxShadow: "0 6px 20px rgba(16,24,36,0.14)",
      flexDirection: "row",
      gap: 6,
      maxWidth: 160,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    mapChipButtonHover: { backgroundColor: t.cardSurface },
    mapChipButtonActive: {
      backgroundColor: t.cardSurface,
      borderColor: `rgba(${accent.rgb},0.28)`,
    },
    mapChipText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    layerActiveText: { color: t.textTertiary, fontSize: 10.5, fontWeight: "600" },
    layerMenu: {
      backgroundColor: t.cardSurface,
      borderColor: t.separatorStrong,
      borderRadius: 13,
      borderWidth: 1,
      boxShadow: "0 12px 32px rgba(16,24,36,0.16), 0 2px 8px rgba(16,24,36,0.08)",
      gap: 10,
      padding: 12,
      position: "absolute",
      right: 0,
      top: 44,
      width: 340,
      zIndex: 20,
    },
    layerMenuHeader: { alignItems: "center", flexDirection: "row" },
    layerMenuTitle: { color: t.textPrimary, fontSize: 13, fontWeight: "700" },
    layerMenuSubtitle: { color: t.textTertiary, fontSize: 10.5, lineHeight: 15, marginTop: 2 },
    layerOptionGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 7,
    },
    layerOption: {
      alignItems: "center",
      borderColor: t.controlBorder,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      minHeight: 58,
      padding: 7,
      width: 154,
    },
    layerOptionActive: {
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.36)`,
    },
    layerOptionDisabled: { opacity: 0.42 },
    layerOptionPreview: {
      borderColor: t.separator,
      borderRadius: 7,
      borderWidth: 1,
      height: 40,
      overflow: "hidden",
      position: "relative",
      width: 46,
    },
    layerPreviewWater: {
      bottom: -9,
      height: 26,
      position: "absolute",
      right: -5,
      transform: [{ rotate: "-18deg" }],
      width: 42,
    },
    layerPreviewRoad: {
      height: 3,
      left: -5,
      position: "absolute",
      top: 16,
      transform: [{ rotate: "-24deg" }],
      width: 58,
    },
    layerOptionCopy: { flex: 1, minWidth: 0 },
    layerOptionTitleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
    },
    layerOptionTitle: { color: t.textPrimary, fontSize: 11.5, fontWeight: "700" },
    layerOptionDescription: { color: t.textTertiary, fontSize: 9.5, lineHeight: 13, marginTop: 2 },
    trafficLayerRow: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 9,
      minHeight: 48,
      opacity: 0.72,
      paddingHorizontal: 9,
      paddingVertical: 7,
    },
    trafficLayerIcon: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderRadius: 8,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    trafficLayerTitle: { color: t.textSecondary, fontSize: 11.5, fontWeight: "700" },
    trafficLayerStatus: { color: t.textTertiary, fontSize: 9.5, fontWeight: "600" },

    // Trajectory "lit-up" count chip
    trajectoryFoot: {
      alignItems: "center",
      bottom: 26,
      left: 16,
      position: "absolute",
      right: 16,
      zIndex: 8,
    },
    litChip: {
      alignItems: "center",
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 999,
      borderWidth: 1,
      boxShadow: "0 6px 18px rgba(16,24,36,0.14)",
      flexDirection: "row",
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    litChipText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },

    // Planning
    planPanel: {
      backgroundColor: t.mainSurface,
      display: "flex",
      flex: 1,
      flexDirection: "column",
      minHeight: 0,
      overflow: "hidden",
    },
    planHeader: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 6,
      justifyContent: "space-between",
      minHeight: 54,
      paddingHorizontal: 24,
      paddingVertical: 9,
    },
    planHeaderLeading: { alignItems: "center", flex: 1, flexDirection: "row", gap: 8, minWidth: 0 },
    planHeaderTitle: { color: t.textPrimary, flexShrink: 1, fontSize: 14, fontWeight: "700" },
    planAdd: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    planBack: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    planEmpty: {
      color: t.textTertiary,
      fontSize: 12.5,
      lineHeight: 19,
      paddingHorizontal: 8,
      paddingVertical: 18,
      textAlign: "center",
    },
    planListContent: {
      alignSelf: "center",
      boxSizing: "border-box",
      gap: 8,
      maxWidth: 920,
      padding: 24,
      width: "100%",
    },
    planListItem: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 9,
      minHeight: 54,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    planListTitle: { color: t.textPrimary, fontSize: 13, fontWeight: "600" },
    planListMeta: { color: t.textTertiary, fontSize: 11, marginTop: 2 },
    planBody: {
      alignSelf: "center",
      boxSizing: "border-box",
      gap: 14,
      maxWidth: 920,
      paddingHorizontal: 24,
      paddingVertical: 20,
      width: "100%",
    },
    planDates: { alignItems: "center", flexDirection: "row", gap: 8 },
    planDayTabs: {
      backgroundColor: t.controlIdle,
      borderRadius: 10,
      flexGrow: 0,
      maxWidth: "100%",
    },
    planDayTabsContent: { alignItems: "center", gap: 4, padding: 4 },
    planDayTab: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 4,
      height: 30,
      paddingHorizontal: 8,
    },
    planDayTabActive: {
      backgroundColor: t.cardSurface,
      boxShadow: "0 1px 3px rgba(20,28,40,0.12)",
    },
    planDayTabText: { color: t.textSecondary, fontSize: 11.5, fontWeight: "700" },
    planDayTabTextActive: { color: accent.accentText },
    planDayTabDate: { color: t.textTertiary, fontSize: 9.5 },
    planDayDot: { borderRadius: 999, height: 8, width: 8 },
    planDayAdd: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    planStopsHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    planSectionHeading: { alignItems: "center", flexDirection: "row", gap: 5 },
    planSectionLabel: { color: t.textTertiary, fontSize: 11, fontWeight: "700" },
    planAddStop: { alignItems: "center", flexDirection: "row", gap: 4 },
    planAddStopText: { color: accent.accentText, fontSize: 12, fontWeight: "600" },
    planDaySection: { gap: 8 },
    planDayHeader: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 2 },
    planDayColorBar: { alignSelf: "stretch", borderRadius: 999, width: 3 },
    planDayTitle: { fontSize: 12.5, fontWeight: "700" },
    planDaySubtitle: { color: t.textTertiary, fontSize: 10, marginTop: 1 },
    planDayHeaderAdd: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 3,
      paddingHorizontal: 7,
      paddingVertical: 5,
    },
    planDayHeaderAddText: { fontSize: 10.5, fontWeight: "700" },
    planDayEmpty: {
      alignItems: "center",
      borderColor: t.separator,
      borderRadius: 10,
      borderStyle: "dashed",
      borderWidth: 1,
      justifyContent: "center",
      paddingVertical: 16,
    },
    planDayEmptyText: { color: t.textTertiary, fontSize: 11.5 },
    timelineRow: {
      alignItems: "stretch",
      flexDirection: "row",
      gap: 6,
      minWidth: 0,
      width: "100%",
    },
    timelineTimeColumn: {
      alignItems: "flex-end",
      flexShrink: 0,
      gap: 6,
      paddingTop: 10,
      width: 84,
    },
    timelineRail: { alignItems: "center", flexShrink: 0, width: 14 },
    timelineDot: { borderRadius: 999, borderWidth: 2.5, height: 12, marginTop: 12, width: 12 },
    timelineLine: { flex: 1, marginBottom: -10, marginTop: 2, opacity: 0.34, width: 2 },
    stopCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderLeftWidth: 3,
      borderWidth: 1,
      flex: 1,
      gap: 8,
      minWidth: 0,
      padding: 9,
    },
    stopTop: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
      minWidth: 0,
      overflow: "hidden",
    },
    stopCheck: {
      alignItems: "center",
      borderRadius: 6,
      borderWidth: 1.5,
      flexShrink: 0,
      height: 18,
      justifyContent: "center",
      width: 18,
    },
    stopCheckMark: { color: t.onAccent, fontSize: 11, fontWeight: "700", lineHeight: 13 },
    stopTitle: { color: t.textPrimary, flex: 1, fontSize: 12.5, fontWeight: "600", minWidth: 0 },
    dayBadge: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 7,
      flexDirection: "row",
      flexShrink: 0,
      gap: 1,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    dayBadgeLabel: { color: t.textTertiary, fontSize: 10, fontWeight: "700" },
    dayInput: {
      color: t.textPrimary,
      fontSize: 12,
      fontWeight: "600",
      minWidth: 18,
      paddingHorizontal: 0,
      textAlign: "center",
      width: 18,
    },
    stopRemove: {
      alignItems: "center",
      borderRadius: 6,
      flexShrink: 0,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    stopMetaRow: { alignItems: "center", flexDirection: "row", gap: 6, minWidth: 0 },
    stopLocation: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 8,
      flex: 1,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    stopLocationText: { color: t.textSecondary, flex: 1, fontSize: 11.5, minWidth: 0 },
  });
}
