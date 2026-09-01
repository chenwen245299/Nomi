import { addProtocol, type StyleSpecification } from "maplibre-gl";
import { PMTiles, Protocol, type RangeResponse, type Source } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { mapReadRange } from "./api";

// ── MapLibre basemaps ─────────────────────────────────────────────────────────
// Online: a complete hosted vector style from OpenFreeMap — keyless, planet-wide,
// serves its own glyphs/sprites, and works out of the box (the old Protomaps demo
// planet archive was retired and now 404s). Offline: downloaded Protomaps
// `.pmtiles` archives, read straight off disk via a byte-range source that calls
// the Rust `travel_map_read_range` command — so a selected offline map renders
// with zero network. Offline uses Protomaps' beige "light" flavor.

/** Keyless hosted vector style, the default online basemap. */
export const ONLINE_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
// Label glyphs + POI sprites for the OFFLINE Protomaps style. These still touch
// the network for labels; tile geometry is fully offline. (Online uses
// OpenFreeMap's own bundled glyphs/sprites, so it needs nothing from here.)
const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";
const SPRITE = "https://protomaps.github.io/basemaps-assets/sprites/v4/light";
const ATTRIBUTION = '© <a href="https://openstreetmap.org">OpenStreetMap</a> · Protomaps';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** A PMTiles byte-range source backed by a local `.pmtiles` on disk. */
class OfflineFileSource implements Source {
  constructor(private readonly name: string) {}
  getKey(): string {
    return `nomi-map:${this.name}`;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const b64 = await mapReadRange(this.name, offset, length);
    return { data: base64ToArrayBuffer(b64) };
  }
}

let protocol: Protocol | null = null;
const registeredOffline = new Set<string>();

/** Register the `pmtiles://` protocol once (used only by offline archives). */
function ensureProtocol(): Protocol {
  if (!protocol) {
    protocol = new Protocol();
    addProtocol("pmtiles", protocol.tile);
  }
  return protocol;
}

/** Attach an offline archive (idempotent) and return its `pmtiles://` archive id. */
function offlineArchiveId(name: string): string {
  const proto = ensureProtocol();
  const key = `nomi-map:${name}`;
  if (!registeredOffline.has(key)) {
    proto.add(new PMTiles(new OfflineFileSource(name)));
    registeredOffline.add(key);
  }
  return key;
}

/**
 * Build a MapLibre style for the chosen basemap. `"online"` returns the hosted
 * OpenFreeMap style URL (maplibre fetches it directly). Any other value is a
 * downloaded offline map name, rendered from its local `.pmtiles` with Protomaps'
 * beige "light" flavor (labels in Simplified Chinese where available).
 */
export function buildStyle(basemap: string): StyleSpecification | string {
  if (!basemap || basemap === "online") {
    return ONLINE_STYLE_URL;
  }
  const archive = offlineArchiveId(basemap);
  return {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${archive}`,
        attribution: ATTRIBUTION,
      },
    },
    // The style-spec LayerSpecification from @protomaps/basemaps is structurally
    // identical to maplibre-gl's; cast to avoid a cross-package nominal mismatch.
    layers: layers("protomaps", namedFlavor("light"), {
      lang: "zh-Hans",
    }) as StyleSpecification["layers"],
  };
}
