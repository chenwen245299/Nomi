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

export type MapLayerId = "auto" | "standard" | "light" | "terrain" | "satellite" | "dark";

/** Keyless hosted vector styles used by the online map-layer picker. */
const ONLINE_STYLE_URLS: Record<Exclude<MapLayerId, "auto" | "terrain" | "satellite">, string> = {
  standard: "https://tiles.openfreemap.org/styles/liberty",
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
export const ONLINE_STYLE_URL = ONLINE_STYLE_URLS.standard;

// The public Sentinel-2 cloudless layer used by MapLibre's own satellite-map
// example. It is static imagery rather than a live traffic product and requires
// no user API key.
const SATELLITE_TILES =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg";
const TERRAIN_TILES = ["a", "b", "c"].map(
  (subdomain) => `https://${subdomain}.tile.opentopomap.org/{z}/{x}/{y}.png`,
);
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
export function buildStyle(
  basemap: string,
  mapLayer: MapLayerId = "auto",
): StyleSpecification | string {
  const layer = mapLayer === "auto" ? "standard" : mapLayer;
  if (!basemap || basemap === "online") {
    if (layer === "satellite") {
      return {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: [SATELLITE_TILES],
            tileSize: 256,
            attribution: "Sentinel-2 cloudless · EOX",
          },
        },
        layers: [{ id: "satellite", type: "raster", source: "satellite" }],
      };
    }
    if (layer === "terrain") {
      return {
        version: 8,
        sources: {
          terrain: {
            type: "raster",
            tiles: TERRAIN_TILES,
            tileSize: 256,
            maxzoom: 17,
            attribution:
              'Kartendaten: © <a href="https://openstreetmap.org">OpenStreetMap</a>-Mitwirkende, SRTM · Kartendarstellung: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
          },
        },
        layers: [{ id: "terrain", type: "raster", source: "terrain" }],
      };
    }
    return ONLINE_STYLE_URLS[layer];
  }
  const archive = offlineArchiveId(basemap);
  const flavor = layer === "dark" ? "dark" : layer === "light" ? "white" : "light";
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
    layers: layers("protomaps", namedFlavor(flavor), {
      lang: "zh-Hans",
    }) as StyleSpecification["layers"],
  };
}

/** Source id watched by MapView's load/error state. */
export function primaryMapSource(basemap: string, mapLayer: MapLayerId): string {
  if ((!basemap || basemap === "online") && mapLayer === "satellite") return "satellite";
  if ((!basemap || basemap === "online") && mapLayer === "terrain") return "terrain";
  return !basemap || basemap === "online" ? "openmaptiles" : "protomaps";
}
