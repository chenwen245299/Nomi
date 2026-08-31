// Notes feature: a folder-organised Markdown notebook built on the reusable
// editor module (src/editor). Notes persist as plain `.md` files under the data
// folder's `notes/` directory, with images in each note's `assets/` sibling.

export { NotesCollection, NotesMainColumn } from "./NotesSection";
export { useNotes, type NotesData } from "./useNotes";
export type { NoteNode } from "./api";
