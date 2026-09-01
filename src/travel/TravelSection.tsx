import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  RiAddLine,
  RiCalendarTodoLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiMap2Line,
  RiMapPin2Fill,
  RiMapPin2Line,
  RiRoadMapLine,
  RiSearch2Line,
  RiStackLine,
} from "@remixicon/react";
import { EmptyIllustration } from "../illustrations";
import { motion, useTheme, type Accent, type Theme } from "../theme";
import { MapView, type MapHandle, type MapMarker } from "./MapView";
import { OfflineMaps } from "./OfflineMaps";
import { TravelNoteEditor } from "./TravelNoteEditor";
import { LocationPicker } from "./LocationPicker";
import { StarChip } from "./ratings";
import { litRegions, type RegionCollection, type RegionLevel } from "./adminBoundaries";
import {
  readNote,
  readNoteAssets,
  type NoteInput,
  type PlanStop,
  type TravelNote,
  type TravelPlan,
} from "./api";
import type { TravelData } from "./useTravel";

type PressState = { pressed: boolean; hovered?: boolean };
type TravelView = "map" | "trajectory" | "planning";

const REGION_LEVELS: { level: RegionLevel; label: string; unit: string }[] = [
  { level: "country", label: "国家", unit: "个国家" },
  { level: "province", label: "省/州", unit: "个省" },
  { level: "city", label: "市", unit: "个市" },
  { level: "county", label: "县", unit: "个区县" },
];

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const uid = () => Math.random().toString(36).slice(2, 10);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return travel.notes;
    return travel.notes.filter((note) =>
      [note.title, note.category, note.address].some((field) =>
        field.toLocaleLowerCase().includes(q),
      ),
    );
  }, [travel.notes, query]);

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

      {travel.notes.length === 0 ? (
        <View style={styles.emptyCollection}>
          <EmptyIllustration color={theme.t.textPrimary} section="travel" size={72} />
          <Text style={styles.emptyText}>还没有旅行笔记{"\n"}点击右上角 + 记录第一段旅程</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyCollection}>
          <Text style={styles.emptyText}>没有匹配的旅行笔记</Text>
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
              onDelete={() => void deleteNote(note)}
              onPress={() => onSelect(note.id)}
              styles={styles}
              theme={theme}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function NoteCard({
  active,
  note,
  onPress,
  onDelete,
  styles,
  theme,
}: {
  active: boolean;
  note: TravelNote;
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
  return (
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
            <View style={styles.cardCategory}>
              <Text numberOfLines={1} style={styles.cardCategoryText}>
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
  const [showOffline, setShowOffline] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [regionLevel, setRegionLevel] = useState<RegionLevel>("province");
  const [regions, setRegions] = useState<RegionCollection | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const mapHandle = useRef<MapHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  // The current map center, read lazily when a location picker opens (kept out of
  // render so it never triggers re-renders on pan).
  const getMapCenter = useCallback(
    () => mapHandle.current?.getCenter() ?? { lat: 35, lng: 105 },
    [],
  );

  const basemap = travel.settings?.basemap ?? "online";
  const openNote = travel.findNote(selectedId);
  const activePlan = travel.plans.find((plan) => plan.id === activePlanId) ?? null;

  const notesWithCoords = useMemo(
    () => travel.notes.filter((note) => note.lat != null && note.lng != null),
    [travel.notes],
  );

  // Markers + route depend on the active view.
  const markers: MapMarker[] = useMemo(() => {
    if (view === "planning") {
      return (activePlan?.stops ?? [])
        .filter((stop) => stop.lat != null && stop.lng != null)
        .map((stop) => ({
          id: stop.id,
          lat: stop.lat as number,
          lng: stop.lng as number,
          color: accent.accent,
          badge: stop.day ? String(stop.day) : undefined,
        }));
    }
    return notesWithCoords.map((note) => ({
      id: note.id,
      lat: note.lat as number,
      lng: note.lng as number,
      color: accent.accent,
      rating: note.rating,
    }));
  }, [view, activePlan, notesWithCoords, accent.accent]);

  const routeLine: [number, number][] | null = useMemo(() => {
    if (view === "planning" && activePlan) {
      const ordered = activePlan.stops
        .filter((stop) => stop.lat != null && stop.lng != null)
        .sort((a, b) => a.day - b.day);
      return ordered.length >= 2
        ? ordered.map((stop) => [stop.lng as number, stop.lat as number])
        : null;
    }
    return null;
  }, [view, activePlan]);

  // Fit the camera to what the current view shows (on view change / first ready).
  useEffect(() => {
    if (!mapReady) return;
    const points = markers.map((m) => ({ lat: m.lat, lng: m.lng }));
    if (points.length > 0) mapHandle.current?.fit(points);
    // Only refit on view switch or when the map becomes ready — not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, mapReady]);

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
    if (view === "planning") return; // stop pins are managed in the panel
    onSelect(id);
  };

  return (
    <View style={styles.mainRoot}>
      <MapView
        accentRgb={accent.rgb}
        basemap={basemap}
        cluster={view !== "planning"}
        markers={markers}
        onMarkerClick={onMarkerClick}
        onReady={(handle) => {
          mapHandle.current = handle;
          setMapReady(true);
        }}
        regions={view === "trajectory" ? regions : null}
        routeLine={routeLine}
        selectedId={selectedId}
      />

      {/* Floating controls (transparent to the map except on the chrome itself) */}
      <View pointerEvents="box-none" style={styles.overlayTop}>
        <View style={styles.segment}>
          <SegmentButton
            accent={accent}
            active={view === "map"}
            icon={RiMap2Line}
            label="地图"
            onPress={() => setView("map")}
            styles={styles}
            theme={theme}
          />
          <SegmentButton
            accent={accent}
            active={view === "trajectory"}
            icon={RiRoadMapLine}
            label="旅行轨迹"
            onPress={() => setView("trajectory")}
            styles={styles}
            theme={theme}
          />
          <SegmentButton
            accent={accent}
            active={view === "planning"}
            icon={RiCalendarTodoLine}
            label="旅行规划"
            onPress={() => setView("planning")}
            styles={styles}
            theme={theme}
          />
        </View>

        <View pointerEvents="box-none" style={styles.overlayRight}>
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
          <Pressable
            accessibilityLabel="离线地图"
            accessibilityRole="button"
            onPress={() => setShowOffline(true)}
            style={({ hovered }: PressState) => [
              styles.mapChipButton,
              motion,
              hovered && styles.mapChipButtonHover,
            ]}
          >
            <RiStackLine color={theme.t.textSecondary} size={16} />
            <Text style={styles.mapChipText}>{basemap === "online" ? "在线地图" : basemap}</Text>
          </Pressable>
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

      {/* Planning: a side panel over the map. */}
      {view === "planning" ? (
        <PlanningPanel
          accent={accent}
          activePlan={activePlan}
          getMapCenter={getMapCenter}
          basemap={basemap}
          onSelectPlan={setActivePlanId}
          onFlyTo={(lat, lng) => mapHandle.current?.flyTo(lat, lng)}
          styles={styles}
          theme={theme}
          travel={travel}
        />
      ) : null}

      {openNote ? (
        <TravelNoteEditor
          accent={accent}
          basemap={basemap}
          categories={travel.categories}
          getMapCenter={getMapCenter}
          note={openNote}
          onClose={() => onSelect(null)}
          onDelete={(id) => {
            void travel.deleteNote(id);
            onSelect(null);
          }}
          onSaveMeta={travel.updateNote}
        />
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

// ── Planning panel ─────────────────────────────────────────────────────────────
function PlanningPanel({
  accent,
  activePlan,
  basemap,
  getMapCenter,
  onFlyTo,
  onSelectPlan,
  styles,
  theme,
  travel,
}: {
  accent: Accent;
  activePlan: TravelPlan | null;
  basemap: string;
  getMapCenter: () => { lat: number; lng: number };
  onFlyTo: (lat: number, lng: number) => void;
  onSelectPlan: (id: string | null) => void;
  styles: TravelStyles;
  theme: Theme;
  travel: TravelData;
}) {
  const [draft, setDraft] = useState<TravelPlan | null>(activePlan);
  const [syncedPlanId, setSyncedPlanId] = useState<string | null>(activePlan?.id ?? null);
  const [pickingStop, setPickingStop] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Reset the local draft only when a *different* plan is selected — not when the
  // same plan's object identity changes after a debounced save (which would
  // clobber edits made while the save was in flight). This render-time sync is
  // React's sanctioned "store info from previous renders" pattern.
  if ((activePlan?.id ?? null) !== syncedPlanId) {
    setSyncedPlanId(activePlan?.id ?? null);
    setDraft(activePlan);
  }

  const scheduleSave = useCallback(
    (next: TravelPlan) => {
      setDraft(next);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void travel.savePlan(next), 500);
    },
    [travel],
  );

  const createPlan = async () => {
    const created = await travel.createPlan({
      title: "",
      startDate: localToday(),
      endDate: "",
      notes: "",
      stops: [],
    });
    if (created) onSelectPlan(created.id);
  };

  const removePlan = async (plan: TravelPlan) => {
    const ok = await confirmDelete(`确定删除行程「${plan.title || "未命名行程"}」吗？`);
    if (ok) {
      await travel.deletePlan(plan.id);
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
        <ScrollView contentContainerStyle={{ gap: 6, padding: 10 }} style={{ minHeight: 0 }}>
          {travel.plans.length === 0 ? (
            <Text style={styles.planEmpty}>
              还没有行程。新建一个，规划每天要去的地方，它们会显示在地图上。
            </Text>
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
  const addStop = () => {
    const day = draft.stops.reduce((max, stop) => Math.max(max, stop.day), 0) || 1;
    scheduleSave({
      ...draft,
      stops: [
        ...draft.stops,
        { id: uid(), title: "", address: "", lat: null, lng: null, day, note: "", done: false },
      ],
    });
  };
  const removeStop = (id: string) =>
    scheduleSave({ ...draft, stops: draft.stops.filter((stop) => stop.id !== id) });

  const pickStop = draft.stops.find((stop) => stop.id === pickingStop) ?? null;

  // Plan detail (a plan is selected).
  return (
    <View style={styles.planPanel}>
      <View style={styles.planHeader}>
        <Pressable
          accessibilityLabel="返回行程列表"
          accessibilityRole="button"
          onPress={() => onSelectPlan(null)}
          style={({ hovered }: PressState) => [
            styles.planBack,
            hovered && { backgroundColor: theme.t.controlHover },
          ]}
        >
          <RiCloseLine color={theme.t.textSecondary} size={15} />
        </Pressable>
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
        <TextInput
          accessibilityLabel="行程标题"
          onChangeText={(title) => scheduleSave({ ...draft, title })}
          placeholder="行程名称"
          placeholderTextColor={theme.t.textTertiary}
          style={styles.planTitleInput}
          value={draft.title}
        />
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

        <View style={styles.planStopsHeader}>
          <Text style={styles.planSectionLabel}>地点 · {draft.stops.length}</Text>
          <Pressable accessibilityRole="button" onPress={addStop} style={styles.planAddStop}>
            <RiAddLine color={accent.accentText} size={14} />
            <Text style={styles.planAddStopText}>添加地点</Text>
          </Pressable>
        </View>

        {draft.stops.map((stop) => (
          <View key={stop.id} style={styles.stopCard}>
            <View style={styles.stopTop}>
              <Pressable
                accessibilityLabel={stop.done ? "标记未完成" : "标记完成"}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: stop.done }}
                onPress={() => updateStop(stop.id, { done: !stop.done })}
                style={[
                  styles.stopCheck,
                  {
                    backgroundColor: stop.done ? accent.accent : "transparent",
                    borderColor: stop.done ? accent.accent : theme.t.controlBorder,
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
                  stop.done && { textDecorationLine: "line-through", color: theme.t.textTertiary },
                ]}
                value={stop.title}
              />
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
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (stop.lat != null && stop.lng != null) onFlyTo(stop.lat, stop.lng);
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
          </View>
        ))}
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
    addButton: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderRadius: 9,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    emptyCollection: {
      alignItems: "center",
      flex: 1,
      gap: 12,
      justifyContent: "center",
      paddingBottom: 48,
      paddingHorizontal: 24,
    },
    emptyText: { color: t.textTertiary, fontSize: 12.5, lineHeight: 19, textAlign: "center" },
    list: { gap: 8, paddingBottom: 16, paddingHorizontal: 12, paddingTop: 4 },
    card: {
      alignItems: "flex-start",
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderRadius: 14,
      borderWidth: 1,
      flexDirection: "row",
      padding: 10,
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
      backgroundColor: `rgba(${accent.rgb},0.13)`,
      borderRadius: 6,
      flexShrink: 0,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    cardCategoryText: { color: accent.accentText, fontSize: 11, fontWeight: "600" },
    cardMetaRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    cardDate: { color: t.textTertiary, fontSize: 11 },

    // Main / map
    mainRoot: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
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
      top: 14,
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
    mapChipText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },

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
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      bottom: 20,
      boxShadow: "0 10px 30px rgba(16,24,36,0.18)",
      left: 16,
      position: "absolute",
      top: 74,
      width: 320,
      zIndex: 9,
    },
    planHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 6,
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    planHeaderTitle: { color: t.textPrimary, fontSize: 13.5, fontWeight: "700" },
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
    planEmpty: { color: t.textTertiary, fontSize: 12, lineHeight: 18, padding: 8 },
    planListItem: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 9,
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    planListTitle: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    planListMeta: { color: t.textTertiary, fontSize: 10.5, marginTop: 1 },
    planBody: { gap: 10, padding: 12 },
    planTitleInput: {
      color: t.textPrimary,
      fontSize: 15,
      fontWeight: "700",
      paddingVertical: 2,
    },
    planDates: { alignItems: "center", flexDirection: "row", gap: 8 },
    planStopsHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    planSectionLabel: { color: t.textTertiary, fontSize: 11, fontWeight: "700" },
    planAddStop: { alignItems: "center", flexDirection: "row", gap: 4 },
    planAddStopText: { color: accent.accentText, fontSize: 12, fontWeight: "600" },
    stopCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      gap: 8,
      padding: 9,
    },
    stopTop: { alignItems: "center", flexDirection: "row", gap: 7 },
    stopCheck: {
      alignItems: "center",
      borderRadius: 6,
      borderWidth: 1.5,
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
      gap: 1,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    dayBadgeLabel: { color: t.textTertiary, fontSize: 10, fontWeight: "700" },
    dayInput: {
      color: t.textPrimary,
      fontSize: 12,
      fontWeight: "600",
      minWidth: 14,
      textAlign: "center",
    },
    stopRemove: {
      alignItems: "center",
      borderRadius: 6,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    stopLocation: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    stopLocationText: { color: t.textSecondary, flex: 1, fontSize: 11.5, minWidth: 0 },
  });
}
