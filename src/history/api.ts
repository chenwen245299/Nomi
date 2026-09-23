import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export type HistoryGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] }
  | { type: "Point"; coordinates: [number, number] };

export interface HistorySettings {
  currentYear: number;
  basemap: string;
}

export interface HistoryLayer {
  id: string;
  name: string;
  sourceFile: string;
  importedAt: number;
  featureCount: number;
  color: string;
  visible: boolean;
  attribution: string;
}

export interface HistoryFeature {
  id: string;
  regionId: string;
  layerId: string;
  name: string;
  kind: string;
  validFrom: number;
  validTo: number;
  color: string;
  source: string;
  confidence: string;
  geometry: HistoryGeometry;
  properties: Record<string, unknown>;
}

export interface HistoryEvent {
  id: string;
  title: string;
  summary: string;
  startYear: number;
  endYear: number;
  location: string;
  regionIds: string[];
  personIds: string[];
  /** Kept in sync for old history files and plain-text export/search. */
  people: string[];
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryPerson {
  id: string;
  name: string;
  courtesyName: string;
  aliases: string[];
  birthYear: number | null;
  deathYear: number | null;
  roles: string[];
  affiliations: string[];
  biography: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryPersonRelation {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  kind: string;
  label: string;
  startYear: number | null;
  endYear: number | null;
  eventIds: string[];
  summary: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryDocument {
  schemaVersion: number;
  settings: HistorySettings;
  layers: HistoryLayer[];
  features: HistoryFeature[];
  events: HistoryEvent[];
  people: HistoryPerson[];
  relations: HistoryPersonRelation[];
}

export interface UpdateHistoryFeatureInput {
  id: string;
  name: string;
  kind: string;
  validFrom: number;
  validTo: number;
  color: string;
  source: string;
  confidence: string;
}

export interface HistoryImportInspection {
  format: string;
  sourceName: string;
  datasets: string[];
  selectedDataset: string | null;
  featureCount: number;
  fields: string[];
  detectedNameField: string | null;
  detectedStartField: string | null;
  detectedEndField: string | null;
  detectedRegionIdField: string | null;
  temporalFeatureCount: number;
  warnings: string[];
}

export interface HistoryImportInput {
  sourcePath: string;
  dataset: string | null;
  layerName: string;
  defaultFrom: number | null;
  defaultTo: number | null;
  attribution: string;
  nameField: string | null;
  startField: string | null;
  endField: string | null;
  regionIdField: string | null;
}

export interface SaveHistoryEventInput {
  id: string | null;
  title: string;
  summary: string;
  startYear: number;
  endYear: number;
  location: string;
  regionIds: string[];
  personIds: string[];
  people: string[];
  tags: string[];
  source: string;
}

export type SaveHistoryPersonInput = Omit<HistoryPerson, "id" | "createdAt" | "updatedAt"> & {
  id: string | null;
};

export type SaveHistoryPersonRelationInput = Omit<
  HistoryPersonRelation,
  "id" | "createdAt" | "updatedAt"
> & { id: string | null };

export const isHistoryTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const EMPTY: HistoryDocument = {
  schemaVersion: 2,
  settings: { currentYear: 200, basemap: "online" },
  layers: [],
  features: [],
  events: [],
  people: [],
  relations: [],
};

const previewDocument: HistoryDocument = structuredClone(EMPTY);

export function previewHistory(): HistoryDocument {
  return structuredClone(previewDocument);
}

export async function loadHistory(): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_load");
  return previewHistory();
}

export async function inspectHistoryImport(
  sourcePath: string,
  dataset: string | null,
): Promise<HistoryImportInspection> {
  if (!isHistoryTauriRuntime()) throw new Error("浏览器预览不支持检查本地文件。");
  return invoke<HistoryImportInspection>("history_inspect_import", { sourcePath, dataset });
}

export async function importHistoryMap(input: HistoryImportInput): Promise<HistoryDocument> {
  if (!isHistoryTauriRuntime()) throw new Error("浏览器预览不支持导入本地文件。");
  return invoke<HistoryDocument>("history_import_map", { ...input });
}

export async function saveHistoryEvent(input: SaveHistoryEventInput): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_save_event", { input });
  const now = Math.floor(Date.now() / 1000);
  const existing = input.id
    ? previewDocument.events.find((event) => event.id === input.id)
    : undefined;
  const next: HistoryEvent = {
    ...input,
    people: input.personIds
      .map((id) => previewDocument.people.find((person) => person.id === id)?.name)
      .filter((name): name is string => Boolean(name)),
    id: input.id ?? `preview-event-${Date.now()}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  previewDocument.events = existing
    ? previewDocument.events.map((event) => (event.id === existing.id ? next : event))
    : [...previewDocument.events, next];
  previewDocument.events.sort((left, right) => left.startYear - right.startYear);
  return structuredClone(previewDocument);
}

export async function deleteHistoryEvent(id: string): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_delete_event", { id });
  previewDocument.events = previewDocument.events.filter((event) => event.id !== id);
  previewDocument.relations = previewDocument.relations.map((relation) => ({
    ...relation,
    eventIds: relation.eventIds.filter((eventId) => eventId !== id),
  }));
  return structuredClone(previewDocument);
}

export async function saveHistoryPerson(input: SaveHistoryPersonInput): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_save_person", { input });
  const now = Math.floor(Date.now() / 1000);
  const existing = input.id
    ? previewDocument.people.find((person) => person.id === input.id)
    : undefined;
  const next: HistoryPerson = {
    ...input,
    id: input.id ?? `preview-person-${Date.now()}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  previewDocument.people = existing
    ? previewDocument.people.map((person) => (person.id === existing.id ? next : person))
    : [...previewDocument.people, next];
  for (const event of previewDocument.events) {
    event.people = event.personIds
      .map((id) => previewDocument.people.find((person) => person.id === id)?.name)
      .filter((name): name is string => Boolean(name));
  }
  return structuredClone(previewDocument);
}

export async function deleteHistoryPerson(id: string): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_delete_person", { id });
  previewDocument.people = previewDocument.people.filter((person) => person.id !== id);
  previewDocument.relations = previewDocument.relations.filter(
    (relation) => relation.fromPersonId !== id && relation.toPersonId !== id,
  );
  previewDocument.events = previewDocument.events.map((event) => ({
    ...event,
    personIds: event.personIds.filter((personId) => personId !== id),
    people: event.personIds
      .filter((personId) => personId !== id)
      .map((personId) => previewDocument.people.find((person) => person.id === personId)?.name)
      .filter((name): name is string => Boolean(name)),
  }));
  return structuredClone(previewDocument);
}

export async function saveHistoryPersonRelation(
  input: SaveHistoryPersonRelationInput,
): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) {
    return invoke<HistoryDocument>("history_save_relation", { input });
  }
  const now = Math.floor(Date.now() / 1000);
  const existing = input.id
    ? previewDocument.relations.find((relation) => relation.id === input.id)
    : undefined;
  const next: HistoryPersonRelation = {
    ...input,
    id: input.id ?? `preview-relation-${Date.now()}`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  previewDocument.relations = existing
    ? previewDocument.relations.map((relation) => (relation.id === existing.id ? next : relation))
    : [...previewDocument.relations, next];
  return structuredClone(previewDocument);
}

export async function deleteHistoryPersonRelation(id: string): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_delete_relation", { id });
  previewDocument.relations = previewDocument.relations.filter((relation) => relation.id !== id);
  return structuredClone(previewDocument);
}

export async function updateHistoryLayer(input: HistoryLayer): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) {
    return invoke<HistoryDocument>("history_update_layer", {
      input: {
        id: input.id,
        name: input.name,
        color: input.color,
        visible: input.visible,
        attribution: input.attribution,
      },
    });
  }
  previewDocument.layers = previewDocument.layers.map((layer) =>
    layer.id === input.id ? input : layer,
  );
  return structuredClone(previewDocument);
}

export async function updateHistoryFeature(
  input: UpdateHistoryFeatureInput,
): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) {
    return invoke<HistoryDocument>("history_update_feature", { input });
  }
  previewDocument.features = previewDocument.features.map((feature) =>
    feature.id === input.id ? { ...feature, ...input } : feature,
  );
  return structuredClone(previewDocument);
}

export async function createHistoryVersion(
  featureId: string,
  effectiveYear: number,
): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) {
    return invoke<HistoryDocument>("history_create_version", { featureId, effectiveYear });
  }
  throw new Error("浏览器预览不支持写入历史区域版本。");
}

export async function deleteHistoryLayer(id: string): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) return invoke<HistoryDocument>("history_delete_layer", { id });
  previewDocument.layers = previewDocument.layers.filter((layer) => layer.id !== id);
  previewDocument.features = previewDocument.features.filter((feature) => feature.layerId !== id);
  return structuredClone(previewDocument);
}

export async function setHistorySettings(settings: HistorySettings): Promise<HistoryDocument> {
  if (isHistoryTauriRuntime()) {
    return invoke<HistoryDocument>("history_set_settings", { settings });
  }
  previewDocument.settings = settings;
  return structuredClone(previewDocument);
}

export async function revealHistory(): Promise<void> {
  if (!isHistoryTauriRuntime()) return;
  await revealItemInDir(await invoke<string>("history_reveal"));
}
