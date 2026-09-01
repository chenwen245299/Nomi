// Papers feature: a research-paper planning board. Papers are nodes on a
// relationship graph (idea · planned · writing · done), each with a reusable
// Markdown body. Data persists under the data folder's `papers/` directory:
// one `graph.json` for the node/edge structure, one folder per paper for its
// Markdown body and inline images.

export { PapersCollection, PapersMainColumn, type PapersView } from "./PapersSection";
export { usePapers, type PapersData } from "./usePapers";
