import type { StyleSpecification } from "maplibre-gl";

// Nomi always opens a hosted, ready-to-use basemap. The previous PMTiles /
// Protomaps workflow asked users to understand archive formats and map sources
// before they could see a map; historical boundaries are now imported as data
// overlays instead of being treated as a replacement basemap.

export type MapLayerId = "auto" | "standard" | "light" | "terrain" | "satellite" | "dark";

/** Keyless hosted vector styles. OpenFreeMap is independent of Protomaps. */
const ONLINE_STYLE_URLS: Record<Exclude<MapLayerId, "auto" | "terrain" | "satellite">, string> = {
  standard: "https://tiles.openfreemap.org/styles/liberty",
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
export const ONLINE_STYLE_URL = ONLINE_STYLE_URLS.standard;

// Static Sentinel-2 imagery used by MapLibre's satellite example. It requires
// no account or API key.
const SATELLITE_TILES =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg";
const TERRAIN_TILES = ["a", "b", "c"].map(
  (subdomain) => `https://${subdomain}.tile.opentopomap.org/{z}/{x}/{y}.png`,
);

/**
 * Build a ready-to-use MapLibre style. `basemap` remains in the signature while
 * old settings are migrated, but local PMTiles selections are intentionally
 * ignored so an old choice can never leave the user with a blank map.
 */
export function buildStyle(
  _basemap: string,
  mapLayer: MapLayerId = "auto",
): StyleSpecification | string {
  const layer = mapLayer === "auto" ? "standard" : mapLayer;
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

/** Source id watched by MapView's load/error state. */
export function primaryMapSource(_basemap: string, mapLayer: MapLayerId): string {
  if (mapLayer === "satellite") return "satellite";
  if (mapLayer === "terrain") return "terrain";
  return "openmaptiles";
}
