import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  RiAddLine,
  RiArrowLeftRightLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiExternalLinkLine,
  RiHistoryLine,
  RiLinksLine,
  RiStackLine,
  RiMap2Line,
  RiMapPinTimeLine,
  RiSave3Line,
  RiTeamLine,
  RiUpload2Line,
  RiUserAddLine,
  RiUserLine,
} from "@remixicon/react";
import {
  cardShadow,
  enterFade,
  enterModal,
  glass,
  modalShadow,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { MapView, type MapHandle, type MapMarker } from "../travel/MapView";
import type { RegionCollection, RegionFeature } from "../travel/adminBoundaries";
import {
  inspectHistoryImport,
  type HistoryDocument,
  type HistoryEvent,
  type HistoryFeature,
  type HistoryImportInspection,
  type HistoryLayer,
  type HistoryPerson,
  type HistoryPersonRelation,
} from "./api";
import type { HistoryData } from "./useHistory";

type PressState = { pressed: boolean; hovered?: boolean };
type HistoryView = "map" | "timeline" | "people";
type TimelineEntry = {
  id: string;
  title: string;
  startYear: number;
  endYear: number;
  color: string;
  kind: "event" | "region";
  summary: string;
  source: string;
  eventId?: string;
  featureId?: string;
};

const MIN_SENTINEL = -10_000;
const MAX_SENTINEL = 10_000;
const CHGIS_DOWNLOAD_URL = "https://chgis.fas.harvard.edu/data/chgis/v6/";

function openExternalUrl(url: string): void {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function yearLabel(year: number): string {
  if (year < 0) return `公元前 ${Math.abs(year)} 年`;
  return `公元 ${year} 年`;
}

function rangeLabel(from: number, to: number): string {
  const left = from <= MIN_SENTINEL ? "更早" : yearLabel(from);
  const right = to >= MAX_SENTINEL ? "延续" : yearLabel(to);
  return `${left} — ${right}`;
}

function confidenceLabel(value: string): string {
  return (
    {
      high: "高可信",
      medium: "中等可信",
      low: "低可信",
      unknown: "未标注",
    }[value] ?? value
  );
}

function propertyText(properties: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const entry = Object.entries(properties).find(
      ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (typeof entry?.[1] === "string" && entry[1].trim()) return entry[1].trim();
  }
  return null;
}

function changeLabel(feature: HistoryFeature, versionCount: number): string {
  const raw = propertyText(feature.properties, [
    "beg_chg_type",
    "beg_chg_ty",
    "beg_chg_t",
    "change_type",
    "change",
  ]);
  if (!raw) return versionCount > 1 ? `边界或属性版本 ${versionCount} 个` : "区域设立或开始有效";
  const normalized = raw.toLowerCase();
  if (normalized.includes("increas") || normalized.includes("expand")) return "辖区扩大";
  if (normalized.includes("shrink") || normalized.includes("decreas")) return "辖区缩小";
  if (normalized.includes("name")) return "名称变更";
  if (normalized.includes("seat") || normalized.includes("location")) return "治所迁移";
  return raw;
}

export function HistoryCollection({
  accent,
  history,
  selectedEventId,
  onSelectEvent,
}: {
  accent: Accent;
  history: HistoryData;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<HistoryEvent | "new" | null>(null);
  const events = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...(history.document?.events ?? [])]
      .filter((event) => {
        if (!needle) return true;
        return [event.title, event.summary, event.location, ...event.people, ...event.tags]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort(
        (left, right) => left.startYear - right.startYear || left.title.localeCompare(right.title),
      );
  }, [history.document?.events, query]);

  return (
    <View style={styles.collection}>
      <View style={styles.eventControls}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setEditing("new")}
          style={({ hovered, pressed }: PressState) => [
            styles.importButton,
            hovered && ({ filter: "brightness(1.03)" } as ViewStyle),
            pressed && styles.pressed,
          ]}
        >
          <RiAddLine color={theme.t.onAccent} size={16} />
          <Text style={styles.importButtonText}>新建历史事件</Text>
        </Pressable>
        <View style={styles.eventSearch}>
          <RiHistoryLine color={theme.t.textTertiary} size={14} />
          <TextInput
            onChangeText={setQuery}
            placeholder="搜索事件、人物或地点…"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.eventSearchInput}
            value={query}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.eventSidebarList}>
        {events.length === 0 ? (
          <View style={styles.emptyLayers}>
            <View style={styles.emptyIcon}>
              <RiHistoryLine color={accent.accentText} size={24} />
            </View>
            <Text style={styles.emptyTitle}>{query ? "没有匹配的事件" : "还没有历史事件"}</Text>
            <Text style={styles.emptyText}>
              事件是历史研究的入口。创建事件后，再把人物、地点、时间和行政区划关联起来。
            </Text>
          </View>
        ) : (
          events.map((event) => (
            <Pressable
              accessibilityRole="button"
              key={event.id}
              onPress={() => {
                history.setCurrentYear(event.startYear);
                onSelectEvent(event.id);
              }}
              style={({ hovered }: PressState) => [
                styles.eventSidebarRow,
                selectedEventId === event.id && styles.eventSidebarRowActive,
                hovered && selectedEventId !== event.id && styles.layerRowHover,
              ]}
            >
              <View style={styles.eventSidebarYear}>
                <Text style={styles.eventSidebarYearText}>{shortYearLabel(event.startYear)}</Text>
              </View>
              <View style={styles.layerText}>
                <Text numberOfLines={1} style={styles.layerName}>
                  {event.title}
                </Text>
                <Text numberOfLines={1} style={styles.layerMeta}>
                  {event.location ||
                    event.people.join("、") ||
                    rangeLabel(event.startYear, event.endYear)}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="编辑事件"
                onPress={(pressEvent) => {
                  pressEvent.stopPropagation();
                  setEditing(event);
                }}
                style={({ hovered }: PressState) => [
                  styles.eventEditButton,
                  hovered && styles.controlHover,
                ]}
              >
                <Text style={styles.eventEditText}>编辑</Text>
              </Pressable>
            </Pressable>
          ))
        )}
      </ScrollView>

      {editing ? (
        <EventDialog
          accent={accent}
          event={editing === "new" ? null : editing}
          history={history}
          onClose={() => setEditing(null)}
          onDeleted={() => {
            setEditing(null);
            onSelectEvent(null);
          }}
          onSaved={(event) => {
            setEditing(null);
            onSelectEvent(event.id);
          }}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function shortYearLabel(year: number): string {
  return year < 0 ? `前${Math.abs(year)}` : `${year}`;
}

function splitList(value: string): string[] {
  return value
    .split(/[，,、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function EventDialog({
  event,
  accent,
  history,
  onClose,
  onDeleted,
  onSaved,
  styles,
  theme,
}: {
  event: HistoryEvent | null;
  accent: Accent;
  history: HistoryData;
  onClose: () => void;
  onDeleted: () => void;
  onSaved: (event: HistoryEvent) => void;
  styles: Styles;
  theme: Theme;
}) {
  const [title, setTitle] = useState(event?.title ?? "");
  const [startYear, setStartYear] = useState(String(event?.startYear ?? history.currentYear));
  const [endYear, setEndYear] = useState(String(event?.endYear ?? history.currentYear));
  const [location, setLocation] = useState(event?.location ?? "");
  const [personIds, setPersonIds] = useState(event?.personIds ?? []);
  const [creatingPerson, setCreatingPerson] = useState(false);
  const [tags, setTags] = useState(event?.tags.join("、") ?? "");
  const [summary, setSummary] = useState(event?.summary ?? "");
  const [source, setSource] = useState(event?.source ?? "");
  const [regionIds, setRegionIds] = useState(event?.regionIds ?? []);
  const [busy, setBusy] = useState(false);
  const parsedStart = Number(startYear);
  const parsedEnd = Number(endYear);
  const invalidYears =
    !Number.isInteger(parsedStart) || !Number.isInteger(parsedEnd) || parsedStart > parsedEnd;
  const selectedRegion = history.selectedFeature;
  const selectedRegionLinked = selectedRegion ? regionIds.includes(selectedRegion.regionId) : false;

  const save = async () => {
    setBusy(true);
    try {
      const saved = await history.saveEvent({
        id: event?.id ?? null,
        title,
        summary,
        startYear: parsedStart,
        endYear: parsedEnd,
        location,
        regionIds,
        personIds,
        people: [],
        tags: splitList(tags),
        source,
      });
      if (saved) onSaved(saved);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <View style={[styles.modalScrim, glass(8, 110), enterFade()]}>
      <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.eventEditorCard, glass(36, 170), enterModal()]}>
        <View style={styles.modalHeader}>
          <View>
            <Text style={styles.modalTitle}>{event ? "编辑历史事件" : "新建历史事件"}</Text>
            <Text style={styles.modalPath}>事件将作为人物、时间与地图区域的组织入口</Text>
          </View>
          <Pressable onPress={onClose} style={styles.iconButton}>
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.formBody} style={styles.importScroll}>
          <Field label="事件标题" styles={styles}>
            <TextInput
              autoFocus
              onChangeText={setTitle}
              placeholder="例如：赤壁之战"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={title}
            />
          </Field>
          <View style={styles.yearFields}>
            <Field label="开始年份" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setStartYear}
                style={styles.input}
                value={startYear}
              />
            </Field>
            <Field label="结束年份" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setEndYear}
                style={styles.input}
                value={endYear}
              />
            </Field>
          </View>
          <Field label="地点" styles={styles}>
            <TextInput
              onChangeText={setLocation}
              placeholder="例如：长江中游、赤壁"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={location}
            />
          </Field>
          <Field label="相关人物" styles={styles}>
            <View style={styles.personPicker}>
              {(history.document?.people ?? []).map((person) => {
                const active = personIds.includes(person.id);
                return (
                  <Pressable
                    key={person.id}
                    onPress={() =>
                      setPersonIds((current) =>
                        active ? current.filter((id) => id !== person.id) : [...current, person.id],
                      )
                    }
                    style={[styles.personPickerChip, active && styles.personPickerChipActive]}
                  >
                    {active ? <RiCheckLine color={accent.accentText} size={12} /> : null}
                    <Text
                      style={[styles.personPickerText, active && styles.personPickerTextActive]}
                    >
                      {person.name}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable onPress={() => setCreatingPerson(true)} style={styles.addPersonChip}>
                <RiUserAddLine color={accent.accentText} size={13} />
                <Text style={styles.addPersonChipText}>新建人物档案</Text>
              </Pressable>
            </View>
            {(history.document?.people.length ?? 0) === 0 ? (
              <Text style={styles.pickerHint}>先创建人物档案，再把人物与事件关联起来。</Text>
            ) : null}
          </Field>
          <Field label="标签" styles={styles}>
            <TextInput
              onChangeText={setTags}
              placeholder="战争、三国"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={tags}
            />
          </Field>
          {selectedRegion ? (
            <Pressable
              onPress={() =>
                setRegionIds((current) =>
                  selectedRegionLinked
                    ? current.filter((id) => id !== selectedRegion.regionId)
                    : [...current, selectedRegion.regionId],
                )
              }
              style={[
                styles.linkRegionButton,
                selectedRegionLinked && styles.linkRegionButtonActive,
              ]}
            >
              <RiMapPinTimeLine color={accent.accentText} size={16} />
              <Text style={styles.linkRegionText}>
                {selectedRegionLinked ? "已关联" : "关联当前地图区域"}：{selectedRegion.name}
              </Text>
            </Pressable>
          ) : null}
          <Field label="事件摘要" styles={styles}>
            <TextInput
              multiline
              onChangeText={setSummary}
              placeholder="发生了什么、起因与结果…"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.eventSummaryInput]}
              value={summary}
            />
          </Field>
          <Field label="史料来源" styles={styles}>
            <TextInput
              multiline
              onChangeText={setSource}
              placeholder="书名、卷次、页码或链接"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.sourceInput]}
              value={source}
            />
          </Field>
          {invalidYears ? (
            <Text style={styles.errorText}>年份必须是整数，且开始不能晚于结束。</Text>
          ) : null}
          {history.error ? <Text style={styles.errorText}>{history.error}</Text> : null}
        </ScrollView>
        <View style={styles.eventEditorFooter}>
          {event ? (
            <Pressable
              disabled={busy}
              onPress={() => {
                if (!window.confirm(`删除事件“${event.title}”？`)) return;
                void history.deleteEvent(event.id).then(onDeleted);
              }}
              style={styles.deleteEventButton}
            >
              <RiDeleteBinLine color={theme.t.errorText} size={15} />
              <Text style={styles.deleteEventText}>删除事件</Text>
            </Pressable>
          ) : null}
          <View style={styles.eventEditorActions}>
            <Pressable onPress={onClose} style={styles.cancelButton}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={busy || !title.trim() || invalidYears}
              onPress={() => void save()}
              style={[
                styles.confirmButton,
                (busy || !title.trim() || invalidYears) && styles.disabled,
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <RiSave3Line color="#fff" size={15} />
              )}
              <Text style={styles.confirmText}>保存事件</Text>
            </Pressable>
          </View>
        </View>
        {creatingPerson ? (
          <PersonDialog
            history={history}
            onClose={() => setCreatingPerson(false)}
            onSaved={(person) => {
              setPersonIds((current) =>
                current.includes(person.id) ? current : [...current, person.id],
              );
              setCreatingPerson(false);
            }}
            person={null}
            styles={styles}
            theme={theme}
          />
        ) : null}
      </View>
    </View>,
    document.body,
  );
}

function HistoryLayerManagerContent({
  accent,
  history,
  selectedLayerId,
  onSelectLayer,
}: {
  accent: Accent;
  history: HistoryData;
  selectedLayerId: string | null;
  onSelectLayer: (id: string | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [importPath, setImportPath] = useState<string | null>(null);
  const layers = history.document?.layers ?? [];

  const chooseMapData = async () => {
    const selected = await openDialog({
      multiple: false,
      title: "导入历史区域地图",
      filters: [
        {
          name: "历史地图数据",
          extensions: ["zip", "shp", "geojson", "json", "kml", "gpkg", "tab"],
        },
      ],
    });
    if (typeof selected === "string") setImportPath(selected);
  };

  return (
    <View style={styles.collection}>
      <View style={styles.collectionIntro}>
        <Pressable
          accessibilityLabel="打开 CHGIS 历史地图官方下载页"
          accessibilityRole="link"
          onPress={() => openExternalUrl(CHGIS_DOWNLOAD_URL)}
          style={({ hovered, pressed }: PressState) => [
            styles.downloadMapButton,
            hovered && styles.downloadMapButtonHover,
            pressed && styles.pressed,
          ]}
        >
          <View style={styles.downloadMapIcon}>
            <RiDownload2Line color={accent.accentText} size={18} />
          </View>
          <View style={styles.downloadMapCopy}>
            <Text style={styles.downloadMapTitle}>下载 CHGIS 历史地图</Text>
            <Text style={styles.downloadMapHint}>
              哈佛官方 V6 · 请选择 TIME SERIES Data（包含行政区划有效时间）
            </Text>
          </View>
          <RiExternalLinkLine color={theme.t.textTertiary} size={15} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void chooseMapData()}
          style={({ hovered, pressed }: PressState) => [
            styles.importButton,
            hovered && ({ filter: "brightness(1.03)" } as ViewStyle),
            pressed && styles.pressed,
          ]}
        >
          <RiUpload2Line color={theme.t.onAccent} size={16} />
          <Text style={styles.importButtonText}>导入已下载的地图数据</Text>
        </Pressable>
        <Text style={styles.collectionHint}>
          支持 ZIP / Shapefile / GeoJSON / KML，本地自动转换，不会上传原始文件。
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.layerList}>
        {layers.length === 0 ? (
          <View style={styles.emptyLayers}>
            <View style={styles.emptyIcon}>
              <RiStackLine color={accent.accentText} size={24} />
            </View>
            <Text style={styles.emptyTitle}>还没有历史图层</Text>
            <Text style={styles.emptyText}>
              直接选择下载的地图文件。Nomi 会检查坐标系、属性字段和行政区划有效时间。
            </Text>
          </View>
        ) : (
          layers.map((layer) => (
            <LayerRow
              accent={accent}
              active={selectedLayerId === layer.id}
              key={layer.id}
              layer={layer}
              onDelete={() => {
                if (!window.confirm(`删除图层“${layer.name}”？源文件副本会保留在 imports 中。`)) {
                  return;
                }
                void history.deleteLayer(layer.id).then(() => {
                  if (selectedLayerId === layer.id) onSelectLayer(null);
                });
              }}
              onSelect={() => onSelectLayer(layer.id)}
              onToggle={() => void history.updateLayer({ ...layer, visible: !layer.visible })}
              styles={styles}
              theme={theme}
            />
          ))
        )}
      </ScrollView>

      {importPath ? (
        <ImportDialog
          accent={accent}
          history={history}
          onClose={() => setImportPath(null)}
          path={importPath}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function LayerManagerDialog({
  accent,
  history,
  onClose,
}: {
  accent: Accent;
  history: HistoryData;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  return createPortal(
    <View style={[styles.modalScrim, glass(8, 110), enterFade()]}>
      <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.layerManagerCard, glass(36, 170), enterModal()]}>
        <View style={styles.modalHeader}>
          <View>
            <Text style={styles.modalTitle}>地图资料</Text>
            <Text style={styles.modalPath}>导入和管理行政区划；事件仍是历史研究的主入口</Text>
          </View>
          <Pressable onPress={onClose} style={styles.iconButton}>
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>
        <HistoryLayerManagerContent
          accent={accent}
          history={history}
          onSelectLayer={setSelectedLayerId}
          selectedLayerId={selectedLayerId}
        />
      </View>
    </View>,
    document.body,
  );
}

function LayerRow({
  layer,
  active,
  onSelect,
  onToggle,
  onDelete,
  styles,
  theme,
}: {
  accent: Accent;
  layer: HistoryLayer;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDelete: () => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={({ hovered }: PressState) => [
        styles.layerRow,
        active && styles.layerRowActive,
        hovered && !active && styles.layerRowHover,
      ]}
    >
      <Pressable
        accessibilityLabel={layer.visible ? "隐藏图层" : "显示图层"}
        onPress={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        style={styles.visibilityButton}
      >
        <View
          style={[
            styles.layerSwatch,
            {
              backgroundColor: layer.visible ? layer.color : "transparent",
              borderColor: layer.color,
            },
          ]}
        >
          {layer.visible ? <RiCheckLine color="#fff" size={11} /> : null}
        </View>
      </Pressable>
      <View style={styles.layerText}>
        <Text numberOfLines={1} style={styles.layerName}>
          {layer.name}
        </Text>
        <Text style={styles.layerMeta}>{layer.featureCount} 个历史实例</Text>
      </View>
      <Pressable
        accessibilityLabel="删除图层"
        onPress={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        style={({ hovered }: PressState) => [
          styles.rowAction,
          hovered && { backgroundColor: theme.t.controlHover },
        ]}
      >
        <RiDeleteBinLine color={theme.t.textTertiary} size={14} />
      </Pressable>
    </Pressable>
  );
}

function ImportDialog({
  path,
  accent,
  history,
  onClose,
  styles,
  theme,
}: {
  path: string;
  accent: Accent;
  history: HistoryData;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const stem =
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(zip|shp|geojson|json|kml|gpkg|tab)$/i, "") ?? "历史区域";
  const [name, setName] = useState(stem);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [attribution, setAttribution] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(true);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<HistoryImportInspection | null>(null);
  const [dataset, setDataset] = useState<string | null>(null);
  const [nameField, setNameField] = useState("");
  const [startField, setStartField] = useState("");
  const [endField, setEndField] = useState("");
  const [regionIdField, setRegionIdField] = useState("");

  useEffect(() => {
    let cancelled = false;
    void inspectHistoryImport(path, dataset)
      .then((next) => {
        if (cancelled) return;
        setInspection(next);
        setNameField(next.detectedNameField ?? "");
        setStartField(next.detectedStartField ?? "");
        setEndField(next.detectedEndField ?? "");
        setRegionIdField(next.detectedRegionIdField ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setInspectError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset, path]);

  const fromYear = from.trim() ? Number(from) : null;
  const toYear = to.trim() ? Number(to) : null;
  const invalidYears =
    (fromYear !== null && !Number.isInteger(fromYear)) ||
    (toYear !== null && !Number.isInteger(toYear)) ||
    (fromYear !== null && toYear !== null && fromYear > toYear);

  const submit = async () => {
    setBusy(true);
    try {
      await history.importMap({
        sourcePath: path,
        dataset: dataset ?? inspection?.selectedDataset ?? null,
        layerName: name,
        defaultFrom: fromYear,
        defaultTo: toYear,
        attribution,
        nameField,
        startField,
        endField,
        regionIdField,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <View style={[styles.modalScrim, glass(8, 110), enterFade()]}>
      <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.importCard, glass(36, 170), enterModal()]}>
        <View style={styles.modalHeader}>
          <View>
            <Text style={styles.modalTitle}>导入历史区域</Text>
            <Text numberOfLines={1} style={styles.modalPath}>
              {path}
            </Text>
          </View>
          <Pressable onPress={onClose} style={styles.iconButton}>
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.formBody} style={styles.importScroll}>
          {inspecting ? (
            <View style={styles.inspectingRow}>
              <ActivityIndicator color={accent.accent} size="small" />
              <Text style={styles.inspectingText}>正在检查格式、坐标系和时间字段…</Text>
            </View>
          ) : null}
          {inspectError ? <Text style={styles.errorText}>{inspectError}</Text> : null}
          {inspection ? (
            <View style={styles.inspectSummary}>
              <View style={styles.inspectSummaryTop}>
                <Text style={styles.formatBadge}>{inspection.format}</Text>
                <Text style={styles.inspectStat}>{inspection.featureCount} 个空间要素</Text>
                <Text
                  style={[
                    styles.timeBadge,
                    inspection.temporalFeatureCount === 0 && styles.timeBadgeMissing,
                  ]}
                >
                  {inspection.temporalFeatureCount > 0
                    ? `${inspection.temporalFeatureCount} 个带有效时间`
                    : "未发现有效时间"}
                </Text>
              </View>
              {inspection.warnings.map((warning) => (
                <Text key={warning} style={styles.warningText}>
                  {warning}
                </Text>
              ))}
            </View>
          ) : null}
          {inspection && inspection.datasets.length > 1 ? (
            <Field label="ZIP 内的数据集" styles={styles}>
              <FieldSelect
                onChange={(next) => {
                  setDataset(next);
                  setInspection(null);
                  setInspectError(null);
                  setInspecting(true);
                }}
                options={inspection.datasets}
                placeholder="选择数据集"
                theme={theme}
                value={dataset ?? inspection.selectedDataset ?? ""}
              />
            </Field>
          ) : null}
          <Field label="图层名称" styles={styles}>
            <TextInput onChangeText={setName} style={styles.input} value={name} />
          </Field>
          {inspection ? (
            <>
              <Text style={styles.mappingTitle}>属性字段映射</Text>
              <View style={styles.yearFields}>
                <Field label="区域名称" styles={styles}>
                  <FieldSelect
                    onChange={setNameField}
                    options={inspection.fields}
                    placeholder="不使用字段"
                    theme={theme}
                    value={nameField}
                  />
                </Field>
                <Field label="稳定区域 ID" styles={styles}>
                  <FieldSelect
                    onChange={setRegionIdField}
                    options={inspection.fields}
                    placeholder="自动生成"
                    theme={theme}
                    value={regionIdField}
                  />
                </Field>
              </View>
              <View style={styles.yearFields}>
                <Field label="有效开始字段" styles={styles}>
                  <FieldSelect
                    onChange={setStartField}
                    options={inspection.fields}
                    placeholder="没有开始字段"
                    theme={theme}
                    value={startField}
                  />
                </Field>
                <Field label="有效结束字段" styles={styles}>
                  <FieldSelect
                    onChange={setEndField}
                    options={inspection.fields}
                    placeholder="没有结束字段"
                    theme={theme}
                    value={endField}
                  />
                </Field>
              </View>
            </>
          ) : null}
          <View style={styles.yearFields}>
            <Field label="缺失时的开始年份" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setFrom}
                placeholder="留空表示未知"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={from}
              />
            </Field>
            <Field label="缺失时的结束年份" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setTo}
                placeholder="留空表示延续"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={to}
              />
            </Field>
          </View>
          <Field label="来源 / 署名" styles={styles}>
            <TextInput
              onChangeText={setAttribution}
              placeholder="例如：用户研究资料，仅限本地使用"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={attribution}
            />
          </Field>
          <View style={styles.importNote}>
            <RiMapPinTimeLine color={accent.accentText} size={17} />
            <Text style={styles.importNoteText}>
              地图需为
              WGS84。若源数据不带时间，留空会保存为“年代未知并持续有效”；也可以在这里给整个图层设默认年代，之后在区域详情中继续拆分版本。
            </Text>
          </View>
          {invalidYears ? (
            <Text style={styles.errorText}>年份必须是整数，且开始不能晚于结束。</Text>
          ) : null}
          {history.error ? <Text style={styles.errorText}>{history.error}</Text> : null}
        </ScrollView>
        <View style={styles.modalFooter}>
          <Pressable onPress={onClose} style={styles.cancelButton}>
            <Text style={styles.cancelText}>取消</Text>
          </Pressable>
          <Pressable
            disabled={
              busy || inspecting || !!inspectError || !inspection || !name.trim() || invalidYears
            }
            onPress={() => void submit()}
            style={[
              styles.confirmButton,
              (busy ||
                inspecting ||
                !!inspectError ||
                !inspection ||
                !name.trim() ||
                invalidYears) &&
                styles.disabled,
            ]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <RiUpload2Line color="#fff" size={16} />
            )}
            <Text style={styles.confirmText}>导入</Text>
          </Pressable>
        </View>
      </View>
    </View>,
    document.body,
  );
}

function FieldSelect({
  value,
  options,
  placeholder,
  onChange,
  theme,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
  theme: Theme;
}) {
  const style: CSSProperties = {
    appearance: "none",
    background: theme.t.cardSurface,
    border: `1px solid ${theme.t.controlBorder}`,
    borderRadius: 9,
    color: theme.t.textPrimary,
    fontFamily: "inherit",
    fontSize: 12.5,
    minHeight: 36,
    outline: "none",
    padding: "7px 28px 7px 10px",
    width: "100%",
  };
  return (
    <select onChange={(event) => onChange(event.target.value)} style={style} value={value}>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function Field({
  label,
  styles,
  children,
}: {
  label: string;
  styles: Styles;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export function HistoryMainColumn({
  accent,
  history,
  selectedEventId,
  onSelectEvent,
}: {
  accent: Accent;
  history: HistoryData;
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}) {
  const theme = useTheme();
  const compact = useWindowDimensions().width < 700;
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [view, setView] = useState<HistoryView>("map");
  const [layerManagerOpen, setLayerManagerOpen] = useState(false);
  const mapRef = useRef<MapHandle | null>(null);
  const focusedEventId = useRef<string | null>(null);
  const document = history.document;
  const selectedEvent = document?.events.find((event) => event.id === selectedEventId) ?? null;
  const visibleLayerIds = useMemo(
    () =>
      new Set((document?.layers ?? []).filter((layer) => layer.visible).map((layer) => layer.id)),
    [document?.layers],
  );
  const activeFeatures = useMemo(
    () =>
      (document?.features ?? []).filter(
        (feature) =>
          visibleLayerIds.has(feature.layerId) &&
          feature.validFrom <= history.currentYear &&
          feature.validTo >= history.currentYear,
      ),
    [document?.features, history.currentYear, visibleLayerIds],
  );
  const polygonFeatures = activeFeatures.filter(
    (feature) => feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon",
  );
  const pointFeatures = activeFeatures.filter((feature) => feature.geometry.type === "Point");
  const regions = useMemo<RegionCollection>(
    () => ({
      type: "FeatureCollection",
      features: polygonFeatures.map(
        (feature) =>
          ({
            type: "Feature",
            properties: {
              id: feature.id,
              name: feature.name,
              color: feature.color,
              selected:
                feature.id === history.selectedFeatureId ||
                !!selectedEvent?.regionIds.includes(feature.regionId),
            },
            geometry: feature.geometry,
          }) as RegionFeature,
      ),
    }),
    [history.selectedFeatureId, polygonFeatures, selectedEvent?.regionIds],
  );
  const markers = useMemo<MapMarker[]>(
    () =>
      pointFeatures.map((feature) => ({
        id: feature.id,
        lng: feature.geometry.type === "Point" ? feature.geometry.coordinates[0] : 0,
        lat: feature.geometry.type === "Point" ? feature.geometry.coordinates[1] : 0,
        color: feature.color,
      })),
    [pointFeatures],
  );
  const timelineEntries = useMemo(
    () => buildTimelineEntries(document, accent.accent),
    [accent.accent, document],
  );
  const years = useMemo(() => timelineYears(timelineEntries), [timelineEntries]);

  useEffect(() => {
    if (!selectedEvent || !document) {
      focusedEventId.current = null;
      return;
    }
    const focusKey = `${selectedEvent.id}:${selectedEvent.updatedAt}`;
    if (focusedEventId.current === focusKey) return;
    focusedEventId.current = focusKey;
    if (history.currentYear !== selectedEvent.startYear) {
      history.setCurrentYear(selectedEvent.startYear);
    }
    const linkedFeature = document.features.find(
      (feature) =>
        selectedEvent.regionIds.includes(feature.regionId) &&
        feature.validFrom <= selectedEvent.startYear &&
        feature.validTo >= selectedEvent.startYear,
    );
    if (linkedFeature && linkedFeature.id !== history.selectedFeatureId) {
      history.setSelectedFeatureId(linkedFeature.id);
    }
    const linkedFeatures = document.features.filter((feature) =>
      selectedEvent.regionIds.includes(feature.regionId),
    );
    const points = linkedFeatures.flatMap(featurePoints);
    if (points.length) mapRef.current?.fit(points, 70);
  }, [document, history, selectedEvent]);

  if (history.error && !document) {
    return (
      <View style={styles.loading}>
        <Text style={styles.errorText}>{history.error}</Text>
        <Pressable onPress={() => void history.refresh()} style={styles.versionButton}>
          <Text style={styles.versionButtonText}>重试</Text>
        </Pressable>
      </View>
    );
  }

  if (history.loading || !document) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={accent.accent} />
        <Text style={styles.loadingText}>正在读取历史工作区…</Text>
      </View>
    );
  }

  return (
    <View style={styles.main}>
      <View style={styles.mainHeader}>
        {!compact ? (
          <View style={styles.titleBlock}>
            <Text style={styles.mainTitle}>{selectedEvent?.title ?? "历史研究"}</Text>
            <Text style={styles.mainSubtitle}>
              {yearLabel(history.currentYear)} ·{" "}
              {selectedEvent?.location || `${activeFeatures.length} 个有效空间实例`}
            </Text>
          </View>
        ) : null}
        <View style={styles.segmented}>
          <SegmentButton
            active={view === "map"}
            icon={
              <RiMap2Line
                color={view === "map" ? accent.accentText : theme.t.textTertiary}
                size={15}
              />
            }
            label="地图"
            onPress={() => setView("map")}
            styles={styles}
          />
          <SegmentButton
            active={view === "timeline"}
            icon={
              <RiHistoryLine
                color={view === "timeline" ? accent.accentText : theme.t.textTertiary}
                size={15}
              />
            }
            label="时间线"
            onPress={() => setView("timeline")}
            styles={styles}
          />
          <SegmentButton
            active={view === "people"}
            icon={
              <RiTeamLine
                color={view === "people" ? accent.accentText : theme.t.textTertiary}
                size={15}
              />
            }
            label="人物关系"
            onPress={() => setView("people")}
            styles={styles}
          />
        </View>
        <Pressable
          accessibilityLabel="地图资料"
          accessibilityRole="button"
          onPress={() => setLayerManagerOpen(true)}
          style={({ hovered }: PressState) => [styles.mapButton, hovered && styles.controlHover]}
        >
          <RiStackLine color={theme.t.textSecondary} size={15} />
          {!compact ? <Text style={styles.mapButtonText}>地图资料</Text> : null}
        </Pressable>
      </View>

      {view === "map" && document.layers.length === 0 ? (
        <View style={styles.mainEmpty}>
          <View style={styles.mainEmptyIcon}>
            <RiMap2Line color={accent.accentText} size={34} />
          </View>
          <Text style={styles.mainEmptyTitle}>导入你的第一份历史地图数据</Text>
          <Text style={styles.mainEmptyText}>
            事件已经可以独立整理。需要查看疆域时，从右上角“地图资料”导入 ZIP、Shapefile、 GeoJSON 或
            KML；地图图层不会占用左侧事件列表。
          </Text>
          <View style={styles.mainEmptyActions}>
            <Pressable
              accessibilityRole="link"
              onPress={() => openExternalUrl(CHGIS_DOWNLOAD_URL)}
              style={({ hovered }: PressState) => [
                styles.emptyDownloadButton,
                hovered && styles.downloadMapButtonHover,
              ]}
            >
              <RiDownload2Line color={accent.accentText} size={15} />
              <Text style={styles.emptyDownloadText}>从 CHGIS 官方下载</Text>
              <RiExternalLinkLine color={accent.accentText} size={13} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setLayerManagerOpen(true)}
              style={styles.emptyImportButton}
            >
              <RiUpload2Line color={theme.t.onAccent} size={15} />
              <Text style={styles.emptyImportText}>导入本地文件</Text>
            </Pressable>
          </View>
          <Text style={styles.mainEmptyFootnote}>
            推荐下载 TIME SERIES Data；它自带行政区划起止时间，可直接映射到时间线。
          </Text>
        </View>
      ) : view === "map" ? (
        <View style={styles.mapHost}>
          <MapView
            accentRgb={accent.rgb}
            basemap={document.settings.basemap}
            cluster={false}
            initial={{ lat: 34, lng: 108, zoom: 3.5 }}
            markers={markers}
            onMarkerClick={history.setSelectedFeatureId}
            onReady={(handle) => {
              mapRef.current = handle;
            }}
            onRegionClick={history.setSelectedFeatureId}
            regions={regions}
            selectedId={history.selectedFeatureId}
            selectedRegionId={history.selectedFeatureId}
          />
          <View style={styles.yearBadge}>
            <Text style={styles.yearBadgeText}>{yearLabel(history.currentYear)}</Text>
          </View>
          {history.selectedFeature ? (
            <FeatureInspector
              accent={accent}
              feature={history.selectedFeature}
              history={history}
              key={history.selectedFeature.id}
              onClose={() => history.setSelectedFeatureId(null)}
              styles={styles}
              theme={theme}
            />
          ) : null}
          <View style={styles.timelineDock}>
            <TimelineControl
              accent={accent}
              currentYear={history.currentYear}
              entries={timelineEntries}
              max={years.max}
              min={years.min}
              onChange={history.setCurrentYear}
              styles={styles}
              theme={theme}
            />
          </View>
        </View>
      ) : view === "timeline" ? (
        <TimelineView
          accent={accent}
          currentYear={history.currentYear}
          entries={timelineEntries}
          history={history}
          max={years.max}
          min={years.min}
          styles={styles}
          theme={theme}
          onSelectEvent={onSelectEvent}
        />
      ) : (
        <PeopleNetworkView
          accent={accent}
          currentYear={history.currentYear}
          history={history}
          selectedEvent={selectedEvent}
          styles={styles}
          theme={theme}
        />
      )}

      {history.error ? <Text style={styles.inlineError}>{history.error}</Text> : null}
      {layerManagerOpen ? (
        <LayerManagerDialog
          accent={accent}
          history={history}
          onClose={() => setLayerManagerOpen(false)}
        />
      ) : null}
    </View>
  );
}

function optionalYear(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function personYears(person: HistoryPerson): string {
  if (person.birthYear == null && person.deathYear == null) return "生卒年不详";
  const birth = person.birthYear == null ? "?" : shortYearLabel(person.birthYear);
  const death = person.deathYear == null ? "?" : shortYearLabel(person.deathYear);
  return `${birth} — ${death}`;
}

function relationLabel(relation: HistoryPersonRelation): string {
  return relation.label || relation.kind || "有关联";
}

function PersonDialog({
  person,
  history,
  onClose,
  onSaved,
  styles,
  theme,
}: {
  person: HistoryPerson | null;
  history: HistoryData;
  onClose: () => void;
  onSaved: (person: HistoryPerson) => void;
  styles: Styles;
  theme: Theme;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [courtesyName, setCourtesyName] = useState(person?.courtesyName ?? "");
  const [aliases, setAliases] = useState(person?.aliases.join("、") ?? "");
  const [birthYear, setBirthYear] = useState(
    person?.birthYear == null ? "" : String(person.birthYear),
  );
  const [deathYear, setDeathYear] = useState(
    person?.deathYear == null ? "" : String(person.deathYear),
  );
  const [roles, setRoles] = useState(person?.roles.join("、") ?? "");
  const [affiliations, setAffiliations] = useState(person?.affiliations.join("、") ?? "");
  const [biography, setBiography] = useState(person?.biography ?? "");
  const [source, setSource] = useState(person?.source ?? "");
  const [busy, setBusy] = useState(false);
  const parsedBirth = optionalYear(birthYear);
  const parsedDeath = optionalYear(deathYear);
  const invalidYears =
    parsedBirth === undefined ||
    parsedDeath === undefined ||
    (parsedBirth != null && parsedDeath != null && parsedBirth > parsedDeath);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await history.savePerson({
        id: person?.id ?? null,
        name,
        courtesyName,
        aliases: splitList(aliases),
        birthYear: parsedBirth ?? null,
        deathYear: parsedDeath ?? null,
        roles: splitList(roles),
        affiliations: splitList(affiliations),
        biography,
        source,
      });
      if (saved) onSaved(saved);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <View style={[styles.modalScrim, glass(8, 110), enterFade(), styles.personModalLayer]}>
      <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.personEditorCard, glass(36, 180), enterModal()]}>
        <View style={styles.modalHeader}>
          <View>
            <Text style={styles.modalTitle}>{person ? "编辑人物档案" : "新建人物档案"}</Text>
            <Text style={styles.modalPath}>人物档案可被多个事件和关系重复引用</Text>
          </View>
          <Pressable onPress={onClose} style={styles.iconButton}>
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.formBody} style={styles.importScroll}>
          <View style={styles.yearFields}>
            <Field label="姓名" styles={styles}>
              <TextInput
                autoFocus
                onChangeText={setName}
                placeholder="例如：诸葛亮"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={name}
              />
            </Field>
            <Field label="字 / 号" styles={styles}>
              <TextInput
                onChangeText={setCourtesyName}
                placeholder="例如：孔明"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={courtesyName}
              />
            </Field>
          </View>
          <Field label="别名" styles={styles}>
            <TextInput
              onChangeText={setAliases}
              placeholder="用顿号分隔"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={aliases}
            />
          </Field>
          <View style={styles.yearFields}>
            <Field label="生年（可空）" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setBirthYear}
                style={styles.input}
                value={birthYear}
              />
            </Field>
            <Field label="卒年（可空）" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setDeathYear}
                style={styles.input}
                value={deathYear}
              />
            </Field>
          </View>
          <View style={styles.yearFields}>
            <Field label="身份 / 官职" styles={styles}>
              <TextInput
                onChangeText={setRoles}
                placeholder="丞相、军事家"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={roles}
              />
            </Field>
            <Field label="所属势力" styles={styles}>
              <TextInput
                onChangeText={setAffiliations}
                placeholder="蜀汉、刘备集团"
                placeholderTextColor={theme.t.textTertiary}
                style={styles.input}
                value={affiliations}
              />
            </Field>
          </View>
          <Field label="人物小传" styles={styles}>
            <TextInput
              multiline
              onChangeText={setBiography}
              placeholder="人物经历、立场及重要转折…"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.eventSummaryInput]}
              value={biography}
            />
          </Field>
          <Field label="史料来源" styles={styles}>
            <TextInput
              multiline
              onChangeText={setSource}
              placeholder="书名、卷次、页码或链接"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.sourceInput]}
              value={source}
            />
          </Field>
          {invalidYears ? (
            <Text style={styles.errorText}>年份须为整数，且生年不能晚于卒年。</Text>
          ) : null}
          {history.error ? <Text style={styles.errorText}>{history.error}</Text> : null}
        </ScrollView>
        <View style={styles.eventEditorFooter}>
          {person ? (
            <Pressable
              disabled={busy}
              onPress={() => {
                if (!window.confirm(`删除人物“${person.name}”？关联关系也会一并删除。`)) return;
                void history.deletePerson(person.id).then(onClose);
              }}
              style={styles.deleteEventButton}
            >
              <RiDeleteBinLine color={theme.t.errorText} size={15} />
              <Text style={styles.deleteEventText}>删除人物</Text>
            </Pressable>
          ) : null}
          <View style={styles.eventEditorActions}>
            <Pressable onPress={onClose} style={styles.cancelButton}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={busy || !name.trim() || invalidYears}
              onPress={() => void save()}
              style={[
                styles.confirmButton,
                (busy || !name.trim() || invalidYears) && styles.disabled,
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <RiSave3Line color="#fff" size={15} />
              )}
              <Text style={styles.confirmText}>保存人物</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>,
    document.body,
  );
}

const RELATION_KINDS = ["君臣", "盟友", "敌对", "亲属", "师生", "同僚", "婚姻", "继承", "其他"];

function RelationDialog({
  relation,
  initialPersonId,
  history,
  onClose,
  styles,
  theme,
}: {
  relation: HistoryPersonRelation | null;
  initialPersonId: string | null;
  history: HistoryData;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const people = history.document?.people ?? [];
  const [fromPersonId, setFromPersonId] = useState(
    relation?.fromPersonId ?? initialPersonId ?? people[0]?.id ?? "",
  );
  const [toPersonId, setToPersonId] = useState(
    relation?.toPersonId ??
      people.find((person) => person.id !== (initialPersonId ?? people[0]?.id))?.id ??
      "",
  );
  const [kind, setKind] = useState(relation?.kind || "君臣");
  const [label, setLabel] = useState(relation?.label ?? "");
  const [startYear, setStartYear] = useState(
    relation?.startYear == null ? "" : String(relation.startYear),
  );
  const [endYear, setEndYear] = useState(relation?.endYear == null ? "" : String(relation.endYear));
  const [eventIds, setEventIds] = useState(relation?.eventIds ?? []);
  const [summary, setSummary] = useState(relation?.summary ?? "");
  const [source, setSource] = useState(relation?.source ?? "");
  const [busy, setBusy] = useState(false);
  const parsedStart = optionalYear(startYear);
  const parsedEnd = optionalYear(endYear);
  const invalid =
    !fromPersonId ||
    !toPersonId ||
    fromPersonId === toPersonId ||
    parsedStart === undefined ||
    parsedEnd === undefined ||
    (parsedStart != null && parsedEnd != null && parsedStart > parsedEnd);
  const selectStyle: CSSProperties = {
    background: theme.t.controlIdle,
    border: `1px solid ${theme.t.controlBorder}`,
    borderRadius: 8,
    color: theme.t.textPrimary,
    fontSize: 12,
    height: 36,
    padding: "0 10px",
    width: "100%",
  };

  const save = async () => {
    setBusy(true);
    try {
      await history.saveRelation({
        id: relation?.id ?? null,
        fromPersonId,
        toPersonId,
        kind,
        label,
        startYear: parsedStart ?? null,
        endYear: parsedEnd ?? null,
        eventIds,
        summary,
        source,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <View style={[styles.modalScrim, glass(8, 110), enterFade(), styles.personModalLayer]}>
      <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
      <View style={[styles.personEditorCard, glass(36, 180), enterModal()]}>
        <View style={styles.modalHeader}>
          <View>
            <Text style={styles.modalTitle}>{relation ? "编辑人物关系" : "新建人物关系"}</Text>
            <Text style={styles.modalPath}>关系可限定有效时间，并关联到一个或多个事件</Text>
          </View>
          <Pressable onPress={onClose} style={styles.iconButton}>
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.formBody} style={styles.importScroll}>
          <View style={styles.yearFields}>
            <Field label="人物一" styles={styles}>
              <select
                onChange={(event) => setFromPersonId(event.currentTarget.value)}
                style={selectStyle}
                value={fromPersonId}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="人物二" styles={styles}>
              <select
                onChange={(event) => setToPersonId(event.currentTarget.value)}
                style={selectStyle}
                value={toPersonId}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
          </View>
          <Field label="关系类型" styles={styles}>
            <View style={styles.confidenceRow}>
              {RELATION_KINDS.map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setKind(value)}
                  style={[styles.confidenceChip, kind === value && styles.confidenceChipActive]}
                >
                  <Text
                    style={[styles.confidenceText, kind === value && styles.confidenceTextActive]}
                  >
                    {value}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>
          <Field label="关系说明" styles={styles}>
            <TextInput
              onChangeText={setLabel}
              placeholder="例如：主公与谋士、长期对手"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.input}
              value={label}
            />
          </Field>
          <View style={styles.yearFields}>
            <Field label="开始年份（可空）" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setStartYear}
                style={styles.input}
                value={startYear}
              />
            </Field>
            <Field label="结束年份（可空）" styles={styles}>
              <TextInput
                inputMode="numeric"
                onChangeText={setEndYear}
                style={styles.input}
                value={endYear}
              />
            </Field>
          </View>
          <Field label="关联事件" styles={styles}>
            <View style={styles.personPicker}>
              {(history.document?.events ?? []).map((event) => {
                const active = eventIds.includes(event.id);
                return (
                  <Pressable
                    key={event.id}
                    onPress={() =>
                      setEventIds((current) =>
                        active ? current.filter((id) => id !== event.id) : [...current, event.id],
                      )
                    }
                    style={[styles.personPickerChip, active && styles.personPickerChipActive]}
                  >
                    <Text
                      style={[styles.personPickerText, active && styles.personPickerTextActive]}
                    >
                      {event.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Field>
          <Field label="补充说明" styles={styles}>
            <TextInput
              multiline
              onChangeText={setSummary}
              placeholder="关系怎样建立、改变或结束…"
              placeholderTextColor={theme.t.textTertiary}
              style={[styles.input, styles.eventSummaryInput]}
              value={summary}
            />
          </Field>
          <Field label="史料来源" styles={styles}>
            <TextInput
              multiline
              onChangeText={setSource}
              style={[styles.input, styles.sourceInput]}
              value={source}
            />
          </Field>
          {invalid ? (
            <Text style={styles.errorText}>请选择两个不同人物；年份须为整数且先后有效。</Text>
          ) : null}
          {history.error ? <Text style={styles.errorText}>{history.error}</Text> : null}
        </ScrollView>
        <View style={styles.eventEditorFooter}>
          {relation ? (
            <Pressable
              disabled={busy}
              onPress={() => {
                if (!window.confirm("删除这条人物关系？")) return;
                void history.deleteRelation(relation.id).then(onClose);
              }}
              style={styles.deleteEventButton}
            >
              <RiDeleteBinLine color={theme.t.errorText} size={15} />
              <Text style={styles.deleteEventText}>删除关系</Text>
            </Pressable>
          ) : null}
          <View style={styles.eventEditorActions}>
            <Pressable onPress={onClose} style={styles.cancelButton}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={busy || invalid}
              onPress={() => void save()}
              style={[styles.confirmButton, (busy || invalid) && styles.disabled]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <RiSave3Line color="#fff" size={15} />
              )}
              <Text style={styles.confirmText}>保存关系</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>,
    document.body,
  );
}

function PeopleNetworkView({
  accent,
  currentYear,
  history,
  selectedEvent,
  styles,
  theme,
}: {
  accent: Accent;
  currentYear: number;
  history: HistoryData;
  selectedEvent: HistoryEvent | null;
  styles: Styles;
  theme: Theme;
}) {
  const people = useMemo(() => history.document?.people ?? [], [history.document?.people]);
  const relations = useMemo(() => history.document?.relations ?? [], [history.document?.relations]);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [editingPerson, setEditingPerson] = useState<HistoryPerson | "new" | null>(null);
  const [editingRelation, setEditingRelation] = useState<HistoryPersonRelation | "new" | null>(
    null,
  );
  const effectiveSelectedPersonId = selectedPersonId ?? selectedEvent?.personIds[0] ?? null;
  const selectedPerson = people.find((person) => person.id === effectiveSelectedPersonId) ?? null;
  const highlightedIds = new Set(selectedEvent?.personIds ?? []);
  const visiblePeople = useMemo(() => people.slice(0, 48), [people]);
  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    visiblePeople.forEach((person, index) => {
      if (visiblePeople.length === 1) {
        positions.set(person.id, { x: 50, y: 50 });
        return;
      }
      const ring = Math.floor(index / 12);
      const ringStart = ring * 12;
      const count = Math.min(12, visiblePeople.length - ringStart);
      const angle = ((index - ringStart) / count) * Math.PI * 2 - Math.PI / 2;
      const radiusX = Math.min(40, 23 + ring * 9);
      const radiusY = Math.min(39, 20 + ring * 9);
      positions.set(person.id, {
        x: 50 + Math.cos(angle) * radiusX,
        y: 50 + Math.sin(angle) * radiusY,
      });
    });
    return positions;
  }, [visiblePeople]);
  const personRelations = selectedPerson
    ? relations.filter(
        (relation) =>
          relation.fromPersonId === selectedPerson.id || relation.toPersonId === selectedPerson.id,
      )
    : [];
  const linkedEvents = selectedPerson
    ? (history.document?.events ?? []).filter((event) =>
        event.personIds.includes(selectedPerson.id),
      )
    : [];

  const nameFor = (id: string) => people.find((person) => person.id === id)?.name ?? "未知人物";
  const isRelationActive = (relation: HistoryPersonRelation) =>
    (relation.startYear == null || relation.startYear <= currentYear) &&
    (relation.endYear == null || relation.endYear >= currentYear);

  return (
    <View style={styles.peoplePage}>
      <View style={styles.peopleToolbar}>
        <View style={styles.peopleToolbarCopy}>
          <Text style={styles.peopleToolbarTitle}>人物关系网</Text>
          <Text style={styles.peopleToolbarHint}>
            {selectedEvent
              ? `正在突出显示“${selectedEvent.title}”的参与者`
              : `${people.length} 个人物 · ${relations.length} 条关系 · ${yearLabel(currentYear)}`}
          </Text>
        </View>
        <Pressable onPress={() => setEditingPerson("new")} style={styles.secondaryAction}>
          <RiUserAddLine color={accent.accentText} size={15} />
          <Text style={styles.secondaryActionText}>新建人物</Text>
        </Pressable>
        <Pressable
          disabled={people.length < 2}
          onPress={() => setEditingRelation("new")}
          style={[styles.primaryAction, people.length < 2 && styles.disabled]}
        >
          <RiLinksLine color={theme.t.onAccent} size={15} />
          <Text style={styles.primaryActionText}>新建关系</Text>
        </Pressable>
      </View>
      {people.length === 0 ? (
        <View style={styles.mainEmpty}>
          <View style={styles.mainEmptyIcon}>
            <RiTeamLine color={accent.accentText} size={34} />
          </View>
          <Text style={styles.mainEmptyTitle}>先建立人物库</Text>
          <Text style={styles.mainEmptyText}>
            人物档案可以反复关联到不同事件；人物之间的关系还可以设置起止时间和对应事件。
          </Text>
          <Pressable onPress={() => setEditingPerson("new")} style={styles.emptyImportButton}>
            <RiUserAddLine color={theme.t.onAccent} size={15} />
            <Text style={styles.emptyImportText}>新建第一个人物</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.peopleWorkspace}>
          <View style={styles.networkCanvas}>
            <svg
              aria-label="人物关系图"
              preserveAspectRatio="none"
              style={{
                height: "100%",
                inset: 0,
                overflow: "visible",
                position: "absolute",
                width: "100%",
              }}
              viewBox="0 0 100 100"
            >
              {relations.map((relation) => {
                const from = layout.get(relation.fromPersonId);
                const to = layout.get(relation.toPersonId);
                if (!from || !to) return null;
                const active = isRelationActive(relation);
                return (
                  <g
                    key={relation.id}
                    onClick={() => setEditingRelation(relation)}
                    style={{ cursor: "pointer", opacity: active ? 1 : 0.22 }}
                  >
                    <line
                      stroke={active ? accent.accent : theme.t.textTertiary}
                      strokeWidth="0.35"
                      vectorEffect="non-scaling-stroke"
                      x1={from.x}
                      x2={to.x}
                      y1={from.y}
                      y2={to.y}
                    />
                    <text
                      fill={theme.t.textSecondary}
                      fontSize="2.2"
                      textAnchor="middle"
                      x={(from.x + to.x) / 2}
                      y={(from.y + to.y) / 2 - 1}
                    >
                      {relationLabel(relation)}
                    </text>
                  </g>
                );
              })}
            </svg>
            {visiblePeople.map((person) => {
              const position = layout.get(person.id)!;
              const selected = person.id === effectiveSelectedPersonId;
              const highlighted = highlightedIds.has(person.id);
              return (
                <button
                  aria-label={`查看人物 ${person.name}`}
                  key={person.id}
                  onClick={() => setSelectedPersonId(person.id)}
                  style={{
                    alignItems: "center",
                    background: selected || highlighted ? accent.accent : theme.t.cardSurface,
                    border: `2px solid ${selected ? accent.accent : highlighted ? accent.accent : theme.t.controlBorder}`,
                    borderRadius: 999,
                    boxShadow: selected
                      ? `0 5px 18px rgba(${accent.rgb},.25)`
                      : "0 2px 8px rgba(20,28,40,.10)",
                    color: selected || highlighted ? theme.t.onAccent : theme.t.textPrimary,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    fontSize: 11,
                    fontWeight: 650,
                    height: 58,
                    justifyContent: "center",
                    left: `${position.x}%`,
                    lineHeight: 1.1,
                    padding: 4,
                    position: "absolute",
                    top: `${position.y}%`,
                    transform: "translate(-50%, -50%)",
                    width: 58,
                    zIndex: 2,
                  }}
                  type="button"
                >
                  {person.name.slice(0, 5)}
                  {person.courtesyName ? (
                    <small style={{ fontSize: 8, fontWeight: 500, opacity: 0.8 }}>
                      字 {person.courtesyName.slice(0, 5)}
                    </small>
                  ) : null}
                </button>
              );
            })}
            {people.length > visiblePeople.length ? (
              <Text style={styles.networkLimitHint}>
                关系图先显示前 {visiblePeople.length} 人；人物档案仍全部保留。
              </Text>
            ) : null}
          </View>
          <View style={styles.personInspector}>
            {selectedPerson ? (
              <ScrollView contentContainerStyle={styles.personInspectorBody}>
                <View style={styles.personHeading}>
                  <View style={styles.personAvatar}>
                    <RiUserLine color={accent.accentText} size={21} />
                  </View>
                  <View style={styles.personHeadingCopy}>
                    <Text style={styles.personName}>{selectedPerson.name}</Text>
                    <Text style={styles.personMeta}>
                      {selectedPerson.courtesyName ? `字/号 ${selectedPerson.courtesyName} · ` : ""}
                      {personYears(selectedPerson)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setEditingPerson(selectedPerson)}
                    style={styles.eventEditButton}
                  >
                    <Text style={styles.eventEditText}>编辑</Text>
                  </Pressable>
                </View>
                {selectedPerson.roles.length ? (
                  <Text style={styles.personDetail}>身份：{selectedPerson.roles.join("、")}</Text>
                ) : null}
                {selectedPerson.affiliations.length ? (
                  <Text style={styles.personDetail}>
                    势力：{selectedPerson.affiliations.join("、")}
                  </Text>
                ) : null}
                {selectedPerson.biography ? (
                  <Text style={styles.personBiography}>{selectedPerson.biography}</Text>
                ) : null}
                <View style={styles.inspectorSection}>
                  <Text style={styles.inspectorSectionTitle}>关联事件 · {linkedEvents.length}</Text>
                  {linkedEvents.map((event) => (
                    <Text key={event.id} style={styles.personListLine}>
                      {shortYearLabel(event.startYear)} · {event.title}
                    </Text>
                  ))}
                  {linkedEvents.length === 0 ? (
                    <Text style={styles.inspectorEmpty}>还没有参与任何事件</Text>
                  ) : null}
                </View>
                <View style={styles.inspectorSection}>
                  <Text style={styles.inspectorSectionTitle}>
                    人物关系 · {personRelations.length}
                  </Text>
                  {personRelations.map((relation) => {
                    const otherId =
                      relation.fromPersonId === selectedPerson.id
                        ? relation.toPersonId
                        : relation.fromPersonId;
                    return (
                      <Pressable
                        key={relation.id}
                        onPress={() => setEditingRelation(relation)}
                        style={styles.relationRow}
                      >
                        <View
                          style={[
                            styles.relationStatus,
                            {
                              backgroundColor: isRelationActive(relation)
                                ? accent.accent
                                : theme.t.textTertiary,
                            },
                          ]}
                        />
                        <View style={styles.layerText}>
                          <Text style={styles.relationName}>{nameFor(otherId)}</Text>
                          <Text style={styles.relationMeta}>
                            {relationLabel(relation)}
                            {relation.startYear != null || relation.endYear != null
                              ? ` · ${rangeLabel(relation.startYear ?? MIN_SENTINEL, relation.endYear ?? MAX_SENTINEL)}`
                              : ""}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                  {personRelations.length === 0 ? (
                    <Text style={styles.inspectorEmpty}>还没有人物关系</Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => setEditingRelation("new")}
                  style={styles.linkRegionButton}
                >
                  <RiAddLine color={accent.accentText} size={15} />
                  <Text style={styles.linkRegionText}>从此人物新建关系</Text>
                </Pressable>
              </ScrollView>
            ) : (
              <View style={styles.inspectorPlaceholder}>
                <RiUserLine color={theme.t.textTertiary} size={25} />
                <Text style={styles.inspectorEmpty}>选择一个人物查看档案、事件和关系</Text>
              </View>
            )}
          </View>
        </View>
      )}
      {editingPerson ? (
        <PersonDialog
          history={history}
          onClose={() => setEditingPerson(null)}
          onSaved={(person) => {
            setEditingPerson(null);
            setSelectedPersonId(person.id);
          }}
          person={editingPerson === "new" ? null : editingPerson}
          styles={styles}
          theme={theme}
        />
      ) : null}
      {editingRelation ? (
        <RelationDialog
          history={history}
          initialPersonId={effectiveSelectedPersonId}
          onClose={() => setEditingRelation(null)}
          relation={editingRelation === "new" ? null : editingRelation}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function SegmentButton({
  active,
  icon,
  label,
  onPress,
  styles,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.segmentButton, active && styles.segmentActive]}>
      {icon}
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function TimelineControl({
  accent,
  currentYear,
  min,
  max,
  entries,
  onChange,
  styles,
  theme,
}: {
  accent: Accent;
  currentYear: number;
  min: number;
  max: number;
  entries: TimelineEntry[];
  onChange: (year: number) => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={styles.timelineControl}>
      <View style={styles.timelineTop}>
        <View style={styles.timelineTitleRow}>
          <RiHistoryLine color={accent.accentText} size={15} />
          <Text style={styles.timelineTitle}>事件与区域沿革</Text>
        </View>
        <TextInput
          accessibilityLabel="当前年份"
          inputMode="numeric"
          onChangeText={(value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          style={styles.yearInput}
          value={String(currentYear)}
        />
      </View>
      <View style={styles.rangeWrap}>
        <Text style={styles.rangeYear}>{min}</Text>
        <div style={{ flex: 1, position: "relative", height: 24 }}>
          <input
            aria-label="历史年份"
            max={max}
            min={min}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            style={{ accentColor: accent.accent, cursor: "pointer", width: "100%" }}
            type="range"
            value={Math.max(min, Math.min(max, currentYear))}
          />
          {entries.slice(0, 80).map((entry) => {
            const left = ((entry.startYear - min) / Math.max(1, max - min)) * 100;
            return (
              <button
                aria-label={`${entry.title} ${entry.startYear}`}
                key={entry.id}
                onClick={() => onChange(entry.startYear)}
                style={{
                  background: entry.color,
                  border: "2px solid white",
                  borderRadius: 999,
                  bottom: 0,
                  boxShadow: "0 1px 3px rgba(20,28,40,.22)",
                  cursor: "pointer",
                  height: 8,
                  left: `calc(${left}% - 4px)`,
                  padding: 0,
                  position: "absolute",
                  width: 8,
                }}
                type="button"
              />
            );
          })}
        </div>
        <Text style={styles.rangeYear}>{max}</Text>
      </View>
      <Text style={[styles.timelineHelp, { color: theme.t.textTertiary }]}>
        拖动年份查看当时有效的区域；实心节点是事件与行政区划变更
      </Text>
    </View>
  );
}

function TimelineView({
  accent,
  currentYear,
  min,
  max,
  entries,
  history,
  onSelectEvent,
  styles,
  theme,
}: {
  accent: Accent;
  currentYear: number;
  min: number;
  max: number;
  entries: TimelineEntry[];
  history: HistoryData;
  onSelectEvent: (id: string | null) => void;
  styles: Styles;
  theme: Theme;
}) {
  const nearby = [...entries]
    .sort((a, b) => Math.abs(a.startYear - currentYear) - Math.abs(b.startYear - currentYear))
    .slice(0, 40)
    .sort((a, b) => a.startYear - b.startYear);
  return (
    <View style={styles.timelinePage}>
      <View style={styles.timelinePageControl}>
        <TimelineControl
          accent={accent}
          currentYear={currentYear}
          entries={entries}
          max={max}
          min={min}
          onChange={history.setCurrentYear}
          styles={styles}
          theme={theme}
        />
      </View>
      <ScrollView contentContainerStyle={styles.eventList}>
        {nearby.length === 0 ? (
          <View style={styles.timelineEmpty}>
            <Text style={styles.emptyTitle}>还没有时间线事件</Text>
            <Text style={styles.emptyText}>
              从左侧新建历史事件，或导入带起止年份的行政区划数据。
            </Text>
          </View>
        ) : (
          nearby.map((entry) => (
            <Pressable
              key={entry.id}
              onPress={() => {
                history.setCurrentYear(entry.startYear);
                if (entry.eventId) onSelectEvent(entry.eventId);
                if (entry.featureId) history.setSelectedFeatureId(entry.featureId);
              }}
              style={({ hovered }: PressState) => [
                styles.eventRow,
                hovered && styles.eventRowHover,
              ]}
            >
              <View style={[styles.eventDot, { backgroundColor: entry.color }]} />
              <View style={styles.eventYearBlock}>
                <Text style={styles.eventYear}>{yearLabel(entry.startYear)}</Text>
                <Text style={styles.eventRange}>{rangeLabel(entry.startYear, entry.endYear)}</Text>
              </View>
              <View style={styles.eventBody}>
                <Text style={styles.eventName}>{entry.title}</Text>
                <Text style={styles.eventDescription}>
                  {entry.kind === "event" ? "历史事件" : "行政区划变更"}
                  {entry.summary ? ` · ${entry.summary}` : ""}
                  {entry.source ? ` · ${entry.source}` : ""}
                </Text>
              </View>
              <RiArrowLeftRightLine color={theme.t.textTertiary} size={15} />
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function FeatureInspector({
  feature,
  history,
  onClose,
  styles,
  theme,
}: {
  accent: Accent;
  feature: HistoryFeature;
  history: HistoryData;
  onClose: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const [name, setName] = useState(feature.name);
  const [kind, setKind] = useState(feature.kind);
  const [from, setFrom] = useState(String(feature.validFrom));
  const [to, setTo] = useState(String(feature.validTo));
  const [source, setSource] = useState(feature.source);
  const [confidence, setConfidence] = useState(feature.confidence);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await history.updateFeature({
        id: feature.id,
        name,
        kind,
        validFrom: Number(from),
        validTo: Number(to),
        color: feature.color,
        source,
        confidence,
      });
    } finally {
      setBusy(false);
    }
  };

  const canSplit =
    history.currentYear > feature.validFrom && history.currentYear <= feature.validTo;

  return (
    <View style={[styles.inspector, glass(28, 160)]}>
      <View style={styles.inspectorHeader}>
        <View style={[styles.inspectorColor, { backgroundColor: feature.color }]} />
        <View style={styles.inspectorHeading}>
          <Text numberOfLines={1} style={styles.inspectorTitle}>
            {feature.name}
          </Text>
          <Text style={styles.inspectorSub}>{rangeLabel(feature.validFrom, feature.validTo)}</Text>
        </View>
        <Pressable onPress={onClose} style={styles.iconButton}>
          <RiCloseLine color={theme.t.textSecondary} size={16} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.inspectorBody}>
        <Field label="名称" styles={styles}>
          <TextInput onChangeText={setName} style={styles.input} value={name} />
        </Field>
        <Field label="类型" styles={styles}>
          <TextInput onChangeText={setKind} style={styles.input} value={kind} />
        </Field>
        <View style={styles.yearFields}>
          <Field label="开始年份" styles={styles}>
            <TextInput
              inputMode="numeric"
              onChangeText={setFrom}
              style={styles.input}
              value={from}
            />
          </Field>
          <Field label="结束年份" styles={styles}>
            <TextInput inputMode="numeric" onChangeText={setTo} style={styles.input} value={to} />
          </Field>
        </View>
        <Field label="可信度" styles={styles}>
          <View style={styles.confidenceRow}>
            {["high", "medium", "low", "unknown"].map((value) => (
              <Pressable
                key={value}
                onPress={() => setConfidence(value)}
                style={[styles.confidenceChip, confidence === value && styles.confidenceChipActive]}
              >
                <Text
                  style={[
                    styles.confidenceText,
                    confidence === value && styles.confidenceTextActive,
                  ]}
                >
                  {confidenceLabel(value)}
                </Text>
              </Pressable>
            ))}
          </View>
        </Field>
        <Field label="史料来源" styles={styles}>
          <TextInput
            multiline
            onChangeText={setSource}
            placeholder="书名、卷次、页码或数据集说明"
            placeholderTextColor={theme.t.textTertiary}
            style={[styles.input, styles.sourceInput]}
            value={source}
          />
        </Field>
        <Pressable
          disabled={!canSplit}
          onPress={() =>
            void history
              .createVersion(feature.id, history.currentYear)
              .then(() => history.setSelectedFeatureId(null))
          }
          style={[styles.versionButton, !canSplit && styles.disabled]}
        >
          <RiAddLine color={theme.t.textSecondary} size={15} />
          <Text style={styles.versionButtonText}>从当前年份创建新版本</Text>
        </Pressable>
        <Text style={styles.versionHint}>
          新版本会保留当前形状，并在时间线上形成一个新的变更节点。
        </Text>
      </ScrollView>
      <Pressable disabled={busy} onPress={() => void save()} style={styles.saveButton}>
        {busy ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <RiSave3Line color="#fff" size={15} />
        )}
        <Text style={styles.saveButtonText}>保存区域信息</Text>
      </Pressable>
    </View>
  );
}

function buildTimelineEntries(
  document: HistoryDocument | null,
  eventColor: string,
): TimelineEntry[] {
  if (!document) return [];
  const versionCounts = new Map<string, number>();
  document.features.forEach((feature) => {
    versionCounts.set(feature.regionId, (versionCounts.get(feature.regionId) ?? 0) + 1);
  });
  return [
    ...document.events.map((event): TimelineEntry => ({
      id: `event:${event.id}`,
      title: event.title,
      startYear: event.startYear,
      endYear: event.endYear,
      color: eventColor,
      kind: "event",
      summary: event.location || event.summary,
      source: event.source,
      eventId: event.id,
    })),
    ...document.features
      .filter((feature) => feature.validFrom > MIN_SENTINEL)
      .map((feature): TimelineEntry => ({
        id: `region:${feature.id}`,
        title: feature.name,
        startYear: feature.validFrom,
        endYear: feature.validTo,
        color: feature.color,
        kind: "region",
        summary: changeLabel(feature, versionCounts.get(feature.regionId) ?? 1),
        source: feature.source,
        featureId: feature.id,
      })),
  ].sort(
    (left, right) =>
      left.startYear - right.startYear ||
      (left.kind === right.kind
        ? left.title.localeCompare(right.title)
        : left.kind === "event"
          ? -1
          : 1),
  );
}

function timelineYears(entries: TimelineEntry[]): { min: number; max: number } {
  const starts = entries.map((entry) => entry.startYear).filter((year) => year > MIN_SENTINEL);
  const ends = entries.map((entry) => entry.endYear).filter((year) => year < MAX_SENTINEL);
  if (starts.length === 0 && ends.length === 0) return { min: -300, max: 1900 };
  const min = Math.min(...starts, ...ends);
  const max = Math.max(...starts, ...ends);
  const pad = Math.max(10, Math.round((max - min) * 0.04));
  return { min: min - pad, max: max + pad };
}

function featurePoints(feature: HistoryFeature): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  const walk = (value: unknown) => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      points.push({ lng: value[0], lat: value[1] });
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(feature.geometry.coordinates);
  if (points.length <= 200) return points;
  const stride = Math.ceil(points.length / 200);
  return points.filter((_, index) => index % stride === 0);
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    collection: { flex: 1, minHeight: 0 },
    eventControls: { gap: 8, padding: 10 },
    eventSearch: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 9,
    },
    eventSearchInput: { color: t.textPrimary, flex: 1, fontSize: 11.5, minWidth: 0, padding: 0 },
    eventSidebarList: { gap: 4, padding: 8 },
    eventSidebarRow: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 8,
      minHeight: 58,
      paddingHorizontal: 8,
    },
    eventSidebarRowActive: { backgroundColor: accent.selectedFill },
    eventSidebarYear: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 8,
      justifyContent: "center",
      minHeight: 34,
      width: 45,
    },
    eventSidebarYearText: {
      color: accent.accentText,
      fontSize: 10.5,
      fontVariant: ["tabular-nums"],
      fontWeight: "700",
    },
    eventEditButton: { borderRadius: 7, paddingHorizontal: 6, paddingVertical: 5 },
    eventEditText: { color: t.textTertiary, fontSize: 9.5, fontWeight: "600" },
    collectionIntro: { gap: 8, padding: 10 },
    downloadMapButton: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.30)`,
      borderRadius: 11,
      borderWidth: 1,
      flexDirection: "row",
      gap: 10,
      minHeight: 58,
      paddingHorizontal: 11,
      paddingVertical: 9,
    },
    downloadMapButtonHover: { filter: "brightness(0.98)" } as ViewStyle,
    downloadMapIcon: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderRadius: 9,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    downloadMapCopy: { flex: 1, gap: 3, minWidth: 0 },
    downloadMapTitle: { color: accent.accentText, fontSize: 12.5, fontWeight: "700" },
    downloadMapHint: { color: t.textSecondary, fontSize: 9.5, lineHeight: 14 },
    importButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 10,
      flexDirection: "row",
      gap: 7,
      justifyContent: "center",
      minHeight: 38,
      paddingHorizontal: 12,
    },
    importButtonText: { color: t.onAccent, fontSize: 12.5, fontWeight: "600" },
    collectionHint: { color: t.textTertiary, fontSize: 10.5, lineHeight: 15, paddingHorizontal: 2 },
    layerList: { gap: 5, padding: 8 },
    emptyLayers: { alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 32 },
    emptyIcon: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 14,
      height: 48,
      justifyContent: "center",
      width: 48,
    },
    emptyTitle: { color: t.textPrimary, fontSize: 13, fontWeight: "600" },
    emptyText: { color: t.textTertiary, fontSize: 11, lineHeight: 17, textAlign: "center" },
    layerRow: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 8,
      minHeight: 52,
      paddingHorizontal: 8,
    },
    layerRowActive: { backgroundColor: accent.selectedFill },
    layerRowHover: { backgroundColor: t.controlHover },
    visibilityButton: { alignItems: "center", height: 30, justifyContent: "center", width: 30 },
    layerSwatch: {
      alignItems: "center",
      borderRadius: 5,
      borderWidth: 1.5,
      height: 19,
      justifyContent: "center",
      width: 19,
    },
    layerText: { flex: 1, gap: 3, minWidth: 0 },
    layerName: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    layerMeta: { color: t.textTertiary, fontSize: 10.5 },
    rowAction: {
      alignItems: "center",
      borderRadius: 7,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    controlHover: { backgroundColor: t.controlHover },
    pressed: { opacity: 0.85 },
    modalScrim: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 9000,
    },
    importCard: {
      backgroundColor: t.overlaySurface,
      borderColor: t.edgeHighlight,
      borderRadius: 18,
      borderWidth: 1,
      maxHeight: "calc(100vh - 48px)",
      maxWidth: 560,
      overflow: "hidden",
      width: "calc(100% - 40px)",
      boxShadow: modalShadow(t),
    },
    eventEditorCard: {
      backgroundColor: t.overlaySurface,
      borderColor: t.edgeHighlight,
      borderRadius: 18,
      borderWidth: 1,
      maxHeight: "calc(100vh - 48px)",
      maxWidth: 600,
      overflow: "hidden",
      width: "calc(100% - 40px)",
      boxShadow: modalShadow(t),
    },
    personModalLayer: { zIndex: 9200 },
    personEditorCard: {
      backgroundColor: t.overlaySurface,
      borderColor: t.edgeHighlight,
      borderRadius: 18,
      borderWidth: 1,
      maxHeight: "calc(100vh - 48px)",
      maxWidth: 640,
      overflow: "hidden",
      width: "calc(100% - 40px)",
      boxShadow: modalShadow(t),
    },
    layerManagerCard: {
      backgroundColor: t.overlaySurface,
      borderColor: t.edgeHighlight,
      borderRadius: 18,
      borderWidth: 1,
      height: "min(680px, calc(100vh - 48px))",
      maxWidth: 580,
      overflow: "hidden",
      width: "calc(100% - 40px)",
      boxShadow: modalShadow(t),
    },
    modalHeader: {
      alignItems: "flex-start",
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      padding: 18,
    },
    modalTitle: { color: t.textPrimary, fontSize: 16, fontWeight: "600" },
    modalPath: { color: t.textTertiary, fontSize: 10.5, marginTop: 5, maxWidth: 440 },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    importScroll: { minHeight: 0 },
    formBody: { gap: 14, padding: 18 },
    inspectingRow: { alignItems: "center", flexDirection: "row", gap: 9, paddingVertical: 8 },
    inspectingText: { color: t.textSecondary, fontSize: 11.5 },
    inspectSummary: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 10,
      borderWidth: 1,
      gap: 7,
      padding: 10,
    },
    inspectSummaryTop: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 7 },
    formatBadge: {
      backgroundColor: accent.iconBadge,
      borderRadius: 999,
      color: accent.accentText,
      fontSize: 10,
      fontWeight: "700",
      overflow: "hidden",
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    inspectStat: { color: t.textSecondary, fontSize: 10.5 },
    timeBadge: {
      backgroundColor: "rgba(68, 142, 99, .12)",
      borderRadius: 999,
      color: "#32704b",
      fontSize: 10,
      overflow: "hidden",
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    timeBadgeMissing: { backgroundColor: t.controlIdle, color: t.textTertiary },
    warningText: { color: t.textSecondary, fontSize: 10.5, lineHeight: 16 },
    mappingTitle: { color: t.textPrimary, fontSize: 12, fontWeight: "600" },
    linkRegionButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 7,
      minHeight: 36,
      paddingHorizontal: 10,
    },
    linkRegionButtonActive: { backgroundColor: accent.selectedFill, borderColor: accent.accent },
    linkRegionText: { color: accent.accentText, flex: 1, fontSize: 11.5 },
    personPicker: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      minHeight: 44,
      padding: 7,
    },
    personPickerChip: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 999,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    personPickerChipActive: { backgroundColor: accent.selectedFill },
    personPickerText: { color: t.textSecondary, fontSize: 10.5, fontWeight: "600" },
    personPickerTextActive: { color: accent.accentText },
    addPersonChip: {
      alignItems: "center",
      borderColor: `rgba(${accent.rgb},0.32)`,
      borderRadius: 999,
      borderStyle: "dashed",
      borderWidth: 1,
      flexDirection: "row",
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    addPersonChipText: { color: accent.accentText, fontSize: 10.5, fontWeight: "600" },
    pickerHint: { color: t.textTertiary, fontSize: 10, lineHeight: 15 },
    eventSummaryInput: { minHeight: 88, textAlignVertical: "top" },
    field: { flex: 1, gap: 6 },
    fieldLabel: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    input: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 12.5,
      minHeight: 36,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    yearFields: { flexDirection: "row", gap: 10 },
    importNote: {
      alignItems: "flex-start",
      backgroundColor: accent.iconBadge,
      borderRadius: 10,
      flexDirection: "row",
      gap: 9,
      padding: 11,
    },
    importNoteText: { color: t.textSecondary, flex: 1, fontSize: 11, lineHeight: 17 },
    errorText: { color: t.errorText, fontSize: 11.5 },
    modalFooter: {
      borderTopColor: t.separator,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 9,
      justifyContent: "flex-end",
      padding: 14,
    },
    eventEditorFooter: {
      alignItems: "center",
      borderTopColor: t.separator,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      justifyContent: "space-between",
      padding: 14,
    },
    eventEditorActions: { flexDirection: "row", gap: 9, marginLeft: "auto" },
    deleteEventButton: { alignItems: "center", flexDirection: "row", gap: 6, padding: 8 },
    deleteEventText: { color: t.errorText, fontSize: 11.5, fontWeight: "600" },
    cancelButton: { borderRadius: 9, paddingHorizontal: 15, paddingVertical: 9 },
    cancelText: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    confirmButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 7,
      minWidth: 94,
      paddingHorizontal: 15,
      paddingVertical: 9,
    },
    confirmText: { color: "#fff", fontSize: 12.5, fontWeight: "600" },
    disabled: { opacity: 0.42 },
    loading: { alignItems: "center", flex: 1, gap: 10, justifyContent: "center" },
    loadingText: { color: t.textSecondary, fontSize: 12 },
    main: { backgroundColor: t.mainSurface, flex: 1, minHeight: 0 },
    mainHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 14,
      minHeight: 58,
      paddingHorizontal: 16,
      zIndex: 5,
    },
    titleBlock: { flex: 1, gap: 2, minWidth: 0 },
    mainTitle: { color: t.textPrimary, fontSize: 15, fontWeight: "600" },
    mainSubtitle: { color: t.textTertiary, fontSize: 10.5 },
    segmented: {
      backgroundColor: t.controlIdle,
      borderRadius: 9,
      flexDirection: "row",
      padding: 3,
    },
    segmentButton: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 5,
      minHeight: 29,
      paddingHorizontal: 10,
    },
    segmentActive: { backgroundColor: t.cardSurface, boxShadow: "0 1px 3px rgba(20,28,40,.10)" },
    segmentText: { color: t.textTertiary, fontSize: 11.5, fontWeight: "600" },
    segmentTextActive: { color: accent.accentText },
    mapButton: {
      alignItems: "center",
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      maxWidth: 160,
      minHeight: 34,
      paddingHorizontal: 10,
    },
    mapButtonText: { color: t.textSecondary, fontSize: 11.5 },
    mainEmpty: { alignItems: "center", flex: 1, justifyContent: "center", padding: 30 },
    mainEmptyIcon: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 22,
      height: 72,
      justifyContent: "center",
      marginBottom: 14,
      width: 72,
    },
    mainEmptyTitle: { color: t.textPrimary, fontSize: 17, fontWeight: "600" },
    mainEmptyText: {
      color: t.textSecondary,
      fontSize: 12.5,
      lineHeight: 20,
      marginTop: 8,
      maxWidth: 460,
      textAlign: "center",
    },
    mainEmptyActions: { flexDirection: "row", gap: 9, marginTop: 18 },
    emptyDownloadButton: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.30)`,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 12,
    },
    emptyDownloadText: { color: accent.accentText, fontSize: 11.5, fontWeight: "600" },
    emptyImportButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 12,
    },
    emptyImportText: { color: t.onAccent, fontSize: 11.5, fontWeight: "600" },
    mainEmptyFootnote: {
      color: t.textTertiary,
      fontSize: 10.5,
      lineHeight: 16,
      marginTop: 10,
      textAlign: "center",
    },
    mapHost: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    yearBadge: {
      backgroundColor: "rgba(255,255,255,.92)",
      borderColor: t.controlBorder,
      borderRadius: 999,
      borderWidth: 1,
      left: 14,
      paddingHorizontal: 12,
      paddingVertical: 7,
      position: "absolute",
      top: 14,
    },
    yearBadgeText: { color: t.textPrimary, fontSize: 12, fontWeight: "600" },
    timelineDock: {
      backgroundColor: "rgba(255,255,255,.94)",
      borderColor: t.controlBorder,
      borderRadius: 14,
      bottom: 16,
      left: 16,
      overflow: "hidden",
      position: "absolute",
      right: 16,
      boxShadow: cardShadow(t),
    },
    timelineControl: { gap: 5, paddingHorizontal: 14, paddingVertical: 10 },
    timelineTop: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
    timelineTitleRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    timelineTitle: { color: t.textPrimary, fontSize: 11.5, fontWeight: "600" },
    yearInput: {
      backgroundColor: t.controlIdle,
      borderRadius: 7,
      color: t.textPrimary,
      fontSize: 11.5,
      minHeight: 27,
      paddingHorizontal: 8,
      textAlign: "center",
      width: 70,
    },
    rangeWrap: { alignItems: "center", flexDirection: "row", gap: 9 },
    rangeYear: { color: t.textTertiary, fontSize: 10, fontVariant: ["tabular-nums"] },
    timelineHelp: { fontSize: 9.5, textAlign: "center" },
    timelinePage: { flex: 1, minHeight: 0 },
    peoplePage: { flex: 1, minHeight: 0 },
    peopleToolbar: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 8,
      minHeight: 62,
      paddingHorizontal: 14,
    },
    peopleToolbarCopy: { flex: 1, gap: 3, minWidth: 0 },
    peopleToolbarTitle: { color: t.textPrimary, fontSize: 13, fontWeight: "700" },
    peopleToolbarHint: { color: t.textTertiary, fontSize: 10.5 },
    secondaryAction: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderColor: `rgba(${accent.rgb},0.28)`,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 10,
    },
    secondaryActionText: { color: accent.accentText, fontSize: 11, fontWeight: "600" },
    primaryAction: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 10,
    },
    primaryActionText: { color: t.onAccent, fontSize: 11, fontWeight: "600" },
    peopleWorkspace: { flex: 1, flexDirection: "row", minHeight: 0 },
    networkCanvas: {
      backgroundColor: t.mainSurface,
      flex: 1,
      minHeight: 0,
      overflow: "hidden",
      position: "relative",
    },
    networkLimitHint: {
      bottom: 10,
      color: t.textTertiary,
      fontSize: 9.5,
      left: 12,
      position: "absolute",
    },
    personInspector: {
      backgroundColor: t.cardSurface,
      borderLeftColor: t.separator,
      borderLeftWidth: StyleSheet.hairlineWidth,
      minHeight: 0,
      width: 300,
    },
    personInspectorBody: { gap: 13, padding: 14 },
    personHeading: { alignItems: "center", flexDirection: "row", gap: 9 },
    personAvatar: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 12,
      height: 42,
      justifyContent: "center",
      width: 42,
    },
    personHeadingCopy: { flex: 1, gap: 3, minWidth: 0 },
    personName: { color: t.textPrimary, fontSize: 15, fontWeight: "700" },
    personMeta: { color: t.textTertiary, fontSize: 9.5 },
    personDetail: { color: t.textSecondary, fontSize: 11, lineHeight: 16 },
    personBiography: {
      backgroundColor: t.controlIdle,
      borderRadius: 9,
      color: t.textSecondary,
      fontSize: 10.5,
      lineHeight: 17,
      padding: 10,
    },
    inspectorSection: {
      borderTopColor: t.separator,
      borderTopWidth: StyleSheet.hairlineWidth,
      gap: 7,
      paddingTop: 12,
    },
    inspectorSectionTitle: { color: t.textPrimary, fontSize: 11.5, fontWeight: "700" },
    inspectorEmpty: { color: t.textTertiary, fontSize: 10.5, lineHeight: 16, textAlign: "center" },
    inspectorPlaceholder: {
      alignItems: "center",
      flex: 1,
      gap: 9,
      justifyContent: "center",
      padding: 28,
    },
    personListLine: { color: t.textSecondary, fontSize: 10.5, lineHeight: 16 },
    relationRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 8,
      padding: 7,
    },
    relationStatus: { borderRadius: 999, height: 8, width: 8 },
    relationName: { color: t.textPrimary, fontSize: 11, fontWeight: "600" },
    relationMeta: { color: t.textTertiary, fontSize: 9.5, lineHeight: 14 },
    timelineEmpty: { alignItems: "center", gap: 8, padding: 40 },
    timelinePageControl: {
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
      padding: 10,
    },
    eventList: { gap: 1, padding: 14 },
    eventRow: {
      alignItems: "center",
      borderBottomColor: t.rowDivider,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 12,
      minHeight: 64,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    eventRowHover: { backgroundColor: t.controlHover, borderRadius: 10 },
    eventDot: { borderRadius: 999, height: 10, width: 10 },
    eventYearBlock: { gap: 3, width: 130 },
    eventYear: { color: t.textPrimary, fontSize: 12, fontWeight: "600" },
    eventRange: { color: t.textTertiary, fontSize: 9.5 },
    eventBody: { flex: 1, gap: 4, minWidth: 0 },
    eventName: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    eventDescription: { color: t.textSecondary, fontSize: 10.5 },
    inspector: {
      backgroundColor: t.overlaySurface,
      borderColor: t.edgeHighlight,
      borderRadius: 14,
      borderWidth: 1,
      maxHeight: "calc(100% - 132px)",
      overflow: "hidden",
      position: "absolute",
      right: 14,
      top: 14,
      width: 310,
      boxShadow: cardShadow(t),
    },
    inspectorHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 9,
      padding: 12,
    },
    inspectorColor: { borderRadius: 4, height: 26, width: 8 },
    inspectorHeading: { flex: 1, gap: 3, minWidth: 0 },
    inspectorTitle: { color: t.textPrimary, fontSize: 13.5, fontWeight: "600" },
    inspectorSub: { color: t.textTertiary, fontSize: 9.5 },
    inspectorBody: { gap: 12, padding: 12 },
    sourceInput: { minHeight: 66, textAlignVertical: "top" },
    confidenceRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
    confidenceChip: {
      backgroundColor: t.controlIdle,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    confidenceChipActive: { backgroundColor: accent.selectedFill },
    confidenceText: { color: t.textTertiary, fontSize: 9.5, fontWeight: "600" },
    confidenceTextActive: { color: accent.accentText },
    versionButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      justifyContent: "center",
      minHeight: 34,
    },
    versionButtonText: { color: t.textSecondary, fontSize: 10.5, fontWeight: "600" },
    versionHint: { color: t.textTertiary, fontSize: 9.5, lineHeight: 14 },
    saveButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      flexDirection: "row",
      gap: 6,
      justifyContent: "center",
      minHeight: 40,
    },
    saveButtonText: { color: "#fff", fontSize: 11.5, fontWeight: "600" },
    inlineError: {
      backgroundColor: "rgba(255,255,255,.96)",
      bottom: 8,
      color: t.errorText,
      fontSize: 10.5,
      left: 10,
      padding: 7,
      position: "absolute",
      right: 10,
      textAlign: "center",
    },
  });
}

type Styles = ReturnType<typeof makeStyles>;
