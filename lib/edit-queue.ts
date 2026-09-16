import { useSyncExternalStore } from "react";

/**
 * Element changes picked in the preview, waiting in the chat input until the user sends them.
 *
 * Picking an element and describing a change does not start the agent: the change lands in the
 * composer, more can be added, and sending hands them to the agent one message at a time, in the
 * order they were added — one change's worth of context per turn. A module store rather than React state because the two ends — the preview panel
 * and the chat composer — are on opposite sides of the tree.
 */

/** What the preview bridge reports for a picked element (`lib/preview-bridge.ts`). */
export type PickedElement = {
  tag: string;
  id: string | null;
  classes: string;
  text: string;
  path: string;
  html: string;
  page: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};

export type QueuedEdit = {
  id: string;
  element: PickedElement;
  instruction: string;
};

const EMPTY: QueuedEdit[] = [];
let edits: QueuedEdit[] = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const addEdit = (element: PickedElement, instruction: string) => {
  edits = [...edits, { id: crypto.randomUUID(), element, instruction }];
  emit();
};

export const removeEdit = (id: string) => {
  edits = edits.filter((edit) => edit.id !== id);
  emit();
};

/** Steer: this change goes next. */
export const moveEditToFront = (id: string) => {
  const edit = edits.find((item) => item.id === id);
  if (!edit) return;
  edits = [edit, ...edits.filter((item) => item.id !== id)];
  emit();
};

export const clearEdits = () => {
  if (!edits.length) return;
  edits = EMPTY;
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useQueuedEdits = () =>
  useSyncExternalStore(
    subscribe,
    () => edits,
    () => EMPTY,
  );

/** The element's own segment of its path — `div.trust` — for a compact label. */
export const elementLabel = (element: PickedElement) =>
  element.path.split(" > ").pop() || element.tag;

/**
 * One message for every queued change, in the order added. There is no source map from the
 * rendered page back to a file, so each element is described the ways it can be found in code:
 * its class string, its text and its rendered markup.
 */
export const editsBrief = (queued: QueuedEdit[], note: string) =>
  [
    `Make ${queued.length === 1 ? "this change" : `these ${queued.length} changes`} to elements I selected in the preview${queued.length === 1 ? "" : ", in this order"}:`,
    ...queued.flatMap(({ element, instruction }, index) => [
      "",
      `${index + 1}. \`${element.path}\` on \`${element.page}\` — ${instruction}`,
      ...(element.classes ? [`   - classes: \`${element.classes}\``] : []),
      ...(element.text ? [`   - text: "${element.text}"`] : []),
      "   - rendered HTML:",
      "```html",
      element.html,
      "```",
    ]),
    ...(note.trim() ? ["", note.trim()] : []),
    "",
    queued.length === 1
      ? "Find the element in the source by its classes, text and markup, change only it (and anything the change strictly needs), and check the app when done."
      : "Work through them one after another in the order listed. For each, find the element in the source by its classes, text and markup and change only it (and anything the change strictly needs). Check the app once all of them are done.",
  ].join("\n");
