import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { createPortal } from "react-dom";
import { RiCloseLine, RiMapPin2Fill, RiSearch2Line } from "@remixicon/react";
import {
  enterFade,
  enterModal,
  glass,
  modalShadow,
  motion,
  useTheme,
  type Accent,
  type Theme,
} from "../theme";
import { MapView, type MapHandle } from "./MapView";
import { reverseGeocode, searchPlaces, type GeoResult, type ViewBox } from "./geocode";

type PressState = { pressed: boolean; hovered?: boolean };

export interface PickedLocation {
  lat: number;
  lng: number;
  address: string;
}

/**
 * Pick a place three ways, as requested: search a name (biased to the area on
 * screen), click the map, or type latitude/longitude directly. All three stay in
 * sync — a search or map click fills the coordinate inputs, and vice versa.
 */
export function LocationPicker({
  accent,
  basemap,
  initial,
  initialCenter,
  onCancel,
  onConfirm,
}: {
  accent: Accent;
  basemap: string;
  initial: { lat: number | null; lng: number | null; address: string };
  initialCenter?: { lat: number; lng: number; zoom?: number };
  onCancel: () => void;
  onConfirm: (location: PickedLocation) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [lat, setLat] = useState<string>(initial.lat != null ? String(initial.lat) : "");
  const [lng, setLng] = useState<string>(initial.lng != null ? String(initial.lng) : "");
  const [address, setAddress] = useState(initial.address);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searching = query.trim() !== "" && query.trim() !== searchedFor;
  const mapRef = useRef<MapHandle | null>(null);
  const viewBoxRef = useRef<ViewBox | null>(null);

  const latNum = Number(lat);
  const lngNum = Number(lng);
  const hasPin = lat !== "" && lng !== "" && Number.isFinite(latNum) && Number.isFinite(lngNum);
  const validPin = hasPin && latNum >= -90 && latNum <= 90 && lngNum >= -180 && lngNum <= 180;
  const pick = validPin ? { lat: latNum, lng: lngNum } : null;

  const startCenter = useMemo(() => {
    if (initial.lat != null && initial.lng != null) {
      return { lat: initial.lat, lng: initial.lng, zoom: 12 };
    }
    if (initialCenter)
      return { lat: initialCenter.lat, lng: initialCenter.lng, zoom: initialCenter.zoom ?? 4 };
    return { lat: 35, lng: 105, zoom: 3.1 };
  }, [initial.lat, initial.lng, initialCenter]);

  // Debounced place search, biased to the mini-map's current viewport.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchPlaces(trimmed, viewBoxRef.current, controller.signal)
        .then((found) => setResults(found))
        .catch(() => setResults([]))
        .finally(() => setSearchedFor(trimmed));
    }, 320);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const applyPick = (nextLat: number, nextLng: number, nextAddress?: string) => {
    setLat(nextLat.toFixed(6));
    setLng(nextLng.toFixed(6));
    if (nextAddress !== undefined) setAddress(nextAddress);
    mapRef.current?.flyTo(nextLat, nextLng, Math.max(12, 6));
  };

  const onMapClick = (clickLat: number, clickLng: number) => {
    setLat(clickLat.toFixed(6));
    setLng(clickLng.toFixed(6));
    void reverseGeocode(clickLat, clickLng).then((found) => {
      if (found) setAddress(found);
    });
  };

  const chooseResult = (result: GeoResult) => {
    applyPick(result.lat, result.lng, result.name);
    setQuery("");
    setResults([]);
  };

  const confirm = () => {
    if (!validPin) return;
    onConfirm({ lat: latNum, lng: lngNum, address: address.trim() });
  };

  return createPortal(
    <View style={[styles.scrim, glass(8, 115), enterFade()]}>
      <Pressable accessibilityLabel="关闭" onPress={onCancel} style={styles.scrimHit} />
      <View style={[styles.card, glass(40, 180), enterModal()]}>
        <View style={styles.header}>
          <Text style={styles.title}>选择位置</Text>
          <Pressable
            accessibilityLabel="关闭"
            accessibilityRole="button"
            onPress={onCancel}
            style={({ hovered }: PressState) => [
              styles.iconButton,
              motion,
              hovered && styles.iconButtonHover,
            ]}
          >
            <RiCloseLine color={theme.t.textSecondary} size={17} />
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <View style={[styles.searchBox, motion, searchFocused && styles.searchBoxFocused]}>
            <RiSearch2Line
              color={searchFocused ? accent.accentText : theme.t.textTertiary}
              size={15}
            />
            <TextInput
              accessibilityLabel="搜索地点"
              onBlur={() => setSearchFocused(false)}
              onChangeText={setQuery}
              onFocus={() => setSearchFocused(true)}
              placeholder="搜索地点（优先当前地图范围）…"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.searchInput}
              value={query}
            />
            {searching ? <ActivityIndicator color={theme.t.textTertiary} size="small" /> : null}
          </View>
          {query.trim() !== "" && results.length > 0 ? (
            <View style={styles.results}>
              {results.map((result, index) => (
                <Pressable
                  accessibilityRole="button"
                  key={`${result.lat},${result.lng},${index}`}
                  onPress={() => chooseResult(result)}
                  style={({ hovered }: PressState) => [
                    styles.resultRow,
                    hovered && { backgroundColor: theme.t.controlHover },
                  ]}
                >
                  <RiMapPin2Fill color={accent.accentText} size={15} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={styles.resultName}>
                      {result.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.resultAddress}>
                      {result.displayName}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        <View style={styles.mapFrame}>
          <MapView
            accentRgb={accent.rgb}
            basemap={basemap}
            initial={startCenter}
            markers={[]}
            onMapClick={onMapClick}
            onReady={(handle) => {
              mapRef.current = handle;
            }}
            onViewBoxChange={(vb) => {
              viewBoxRef.current = vb;
            }}
            pick={pick}
          />
          <View pointerEvents="none" style={styles.mapHint}>
            <Text style={styles.mapHintText}>点击地图放置标记</Text>
          </View>
        </View>

        <View style={styles.coordRow}>
          <View style={styles.coordField}>
            <Text style={styles.coordLabel}>纬度 Lat</Text>
            <TextInput
              accessibilityLabel="纬度"
              inputMode="decimal"
              onBlur={() => validPin && mapRef.current?.flyTo(latNum, lngNum, 12)}
              onChangeText={setLat}
              placeholder="-90 ~ 90"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.coordInput}
              value={lat}
            />
          </View>
          <View style={styles.coordField}>
            <Text style={styles.coordLabel}>经度 Lng</Text>
            <TextInput
              accessibilityLabel="经度"
              inputMode="decimal"
              onBlur={() => validPin && mapRef.current?.flyTo(latNum, lngNum, 12)}
              onChangeText={setLng}
              placeholder="-180 ~ 180"
              placeholderTextColor={theme.t.textTertiary}
              style={styles.coordInput}
              value={lng}
            />
          </View>
        </View>
        <View style={styles.addressField}>
          <Text style={styles.coordLabel}>地点名称 / 地址</Text>
          <TextInput
            accessibilityLabel="地址"
            onChangeText={setAddress}
            placeholder="例如 陕西省西安市"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.coordInput}
            value={address}
          />
        </View>

        <View style={styles.footer}>
          {validPin ? null : (
            <Text style={styles.footHint}>请填写有效的经纬度或在地图上选择一个点</Text>
          )}
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            onPress={onCancel}
            style={({ hovered }: PressState) => [
              styles.secondaryButton,
              motion,
              hovered && { backgroundColor: theme.t.controlHover },
            ]}
          >
            <Text style={styles.secondaryButtonText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!validPin}
            onPress={confirm}
            style={[styles.primaryButton, !validPin && { opacity: 0.5 }]}
          >
            <Text style={styles.primaryButtonText}>使用此位置</Text>
          </Pressable>
        </View>
      </View>
    </View>,
    document.body,
  );
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    scrim: {
      alignItems: "center",
      backgroundColor: t.scrim,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      padding: 24,
      position: "absolute",
      right: 0,
      top: 0,
      zIndex: 2600,
    },
    scrimHit: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    card: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separator,
      borderRadius: 18,
      borderWidth: 1,
      boxShadow: modalShadow(t),
      maxHeight: "92%",
      maxWidth: 620,
      overflow: "hidden",
      width: "100%",
    },
    header: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 13,
    },
    title: { color: t.textPrimary, fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
    iconButton: {
      alignItems: "center",
      borderRadius: 8,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    iconButtonHover: { backgroundColor: t.controlHover },
    searchWrap: { paddingHorizontal: 18, paddingTop: 14, position: "relative", zIndex: 5 },
    searchBox: {
      alignItems: "center",
      backgroundColor: t.searchFill,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      height: 38,
      paddingHorizontal: 11,
    },
    searchBoxFocused: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
    },
    searchInput: { color: t.textPrimary, flex: 1, fontSize: 13, minWidth: 0, paddingVertical: 8 },
    results: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 12px 30px rgba(16,24,36,0.16)",
      left: 18,
      marginTop: 6,
      maxHeight: 232,
      overflow: "hidden",
      position: "absolute",
      right: 18,
      top: 52,
      zIndex: 30,
    },
    resultRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 9,
      paddingHorizontal: 11,
      paddingVertical: 9,
    },
    resultName: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    resultAddress: { color: t.textTertiary, fontSize: 10.5, marginTop: 1 },
    mapFrame: {
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      height: 320,
      margin: 18,
      marginBottom: 8,
      overflow: "hidden",
      position: "relative",
    },
    mapHint: {
      backgroundColor: "rgba(27,36,48,0.62)",
      borderRadius: 999,
      bottom: 10,
      left: 10,
      paddingHorizontal: 10,
      paddingVertical: 4,
      position: "absolute",
    },
    mapHintText: { color: "#fff", fontSize: 11, fontWeight: "500" },
    coordRow: { flexDirection: "row", gap: 12, paddingHorizontal: 18 },
    coordField: { flex: 1, gap: 4 },
    addressField: { gap: 4, paddingHorizontal: 18, paddingTop: 10 },
    coordLabel: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
    coordInput: {
      backgroundColor: t.cardSurface,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      paddingHorizontal: 9,
      paddingVertical: 8,
    },
    footer: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 18,
      paddingVertical: 14,
    },
    footHint: { color: t.textTertiary, fontSize: 11 },
    secondaryButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    secondaryButtonText: { color: t.textSecondary, fontSize: 13, fontWeight: "600" },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 34,
      justifyContent: "center",
      paddingHorizontal: 16,
    },
    primaryButtonText: { color: t.onAccent, fontSize: 13, fontWeight: "600" },
  });
}
