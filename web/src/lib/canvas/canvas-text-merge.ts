import { ChangeSet } from "@tiptap/pm/changeset";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { StepMap, Transform } from "@tiptap/pm/transform";
import { getSchema } from "@tiptap/core";
import { createCanvasRichTextExtensions } from "./canvas-rich-text";

const textSchema = new Schema({ nodes: { doc: { content: "text*" }, text: {} } });
type TextEdit = { from: number; to: number; insert: string };
const plainDocument = (text: string) => textSchema.node("doc", null, text ? [textSchema.text(text)] : []);
const splitsSurrogate = (text: string, position: number) => position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]!) && /[\uDC00-\uDFFF]/.test(text[position]!);
const documentSplitsSurrogate = (doc: ProseMirrorNode, position: number) => position > 0 && position < doc.content.size && splitsSurrogate(doc.textBetween(position - 1, position + 1), 1);
function changes(before: ProseMirrorNode, after: ProseMirrorNode) {
    const result: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
    for (const change of ChangeSet.create(before).addSteps(after, [new StepMap([0, before.content.size, after.content.size])], null).changes) {
        const start = documentSplitsSurrogate(before, change.fromA) || documentSplitsSurrogate(after, change.fromB) ? 1 : 0;
        const end = documentSplitsSurrogate(before, change.toA) || documentSplitsSurrogate(after, change.toB) ? 1 : 0;
        const range = { fromA: change.fromA - start, toA: change.toA + end, fromB: change.fromB - start, toB: change.toB + end };
        const previous = result.at(-1);
        if (previous && previous.toA >= range.fromA && previous.toB >= range.fromB) {
            previous.toA = Math.max(previous.toA, range.toA); previous.toB = Math.max(previous.toB, range.toB);
        } else result.push(range);
    }
    return result;
}

// The existing editor's bounded Myers diff also handles multiple edits in a
// single input. Expand UTF-16 boundaries so emoji are indivisible replacements.
export function canvasTextEdits(before: string, after: string): TextEdit[] {
    return changes(plainDocument(before), plainDocument(after)).map(({ fromA, toA, fromB, toB }) => ({ from: fromA, to: toA, insert: after.slice(fromB, toB) }));
}

export function mapCanvasTextOffset(before: string, after: string, offset: number) {
    let delta = 0;
    for (const edit of canvasTextEdits(before, after)) {
        if (offset < edit.from) break;
        if (offset <= edit.to) return edit.from + delta + edit.insert.length;
        delta += edit.insert.length - (edit.to - edit.from);
    }
    return Math.min(after.length, Math.max(0, offset + delta));
}

export function canvasRichTextChangeMap(before: ProseMirrorNode, after: ProseMirrorNode) {
    return new StepMap(changes(before, after).flatMap((change) => [change.fromA, change.toA - change.fromA, change.toB - change.fromB]));
}

// Delete only characters present in the common baseline. Concurrent insertions
// survive deletions/replacements, with committed text first at the same offset.
export function mergeCanvasText(before: string, remote: string, local: string): string {
    if (local === before || local === remote) return remote;
    if (remote === before) return local;
    const rawRemote = canvasTextEdits(before, remote), rawLocal = canvasTextEdits(before, local);
    // Conflicting word replacements must retain each new word, including any
    // baseline letters reused by the diff ("Original" -> "Local" keeps "al").
    const completeWords = (edits: TextEdit[], others: TextEdit[]) => {
        const ranges: { from: number; to: number }[] = [];
        for (const edit of edits) {
            let { from, to } = edit;
            if (/^[A-Za-z0-9_]+$/.test(edit.insert) && /^[A-Za-z0-9_]+$/.test(before.slice(from, to)) && others.some((other) => other.insert && other.to > other.from && from < other.to && to > other.from && Math.max(to - from, edit.insert.length, other.to - other.from, other.insert.length) > 1)) {
                while (from > 0 && /[A-Za-z0-9_]/.test(before[from - 1]!)) from--;
                while (to < before.length && /[A-Za-z0-9_]/.test(before[to]!)) to++;
            }
            const previous = ranges.at(-1);
            if (previous && previous.to >= from) previous.to = Math.max(previous.to, to);
            else ranges.push({ from, to });
        }
        return ranges.map(({ from, to }) => {
            let cursor = from, insert = "";
            for (const edit of edits) {
                if (edit.from < from || edit.to > to) continue;
                insert += before.slice(cursor, edit.from) + edit.insert;
                cursor = edit.to;
            }
            return { from, to, insert: insert + before.slice(cursor, to) };
        });
    };
    const remoteEdits = completeWords(rawRemote, rawLocal), localEdits = completeWords(rawLocal, rawRemote);
    const edits = [...remoteEdits, ...localEdits.filter((edit) => !remoteEdits.some((other) => edit.from === other.from && edit.to === other.to && edit.insert === other.insert))].sort((a, b) => a.from - b.from);
    const output: string[] = [];
    let cursor = 0;
    for (const edit of edits) {
        if (edit.from > cursor) output.push(before.slice(cursor, edit.from));
        output.push(edit.insert);
        cursor = Math.max(cursor, edit.to);
    }
    output.push(before.slice(cursor));
    return output.join("");
}

let richSchema: Schema | undefined;

// Rebase structured editor slices, rather than merging the plain text and
// richText copies separately. This retains paragraph structure and marks.
export function mergeCanvasRichText(before: Record<string, unknown>, remote: Record<string, unknown>, local: Record<string, unknown>) {
    const schema = richSchema ??= getSchema(createCanvasRichTextExtensions());
    const base = schema.nodeFromJSON(before);
    const incoming = schema.nodeFromJSON(remote);
    const edited = schema.nodeFromJSON(local);
    base.check(); incoming.check(); edited.check();
    const remoteChanges = changes(base, incoming);
    const localChanges = changes(base, edited);
    const remoteMap = new StepMap(remoteChanges.flatMap((change) => [change.fromA, change.toA - change.fromA, change.toB - change.fromB]));
    const localMap = new StepMap(localChanges.flatMap((change) => [change.fromA, change.toA - change.fromA, change.toB - change.fromB]));
    const transform = new Transform(incoming);
    const map = (position: number, association: number) => transform.mapping.map(remoteMap.map(position, association), association);
    for (const edit of [...localChanges].reverse()) {
        if (remoteChanges.some((other) => edit.fromA === other.fromA && edit.toA === other.toA && incoming.slice(other.fromB, other.toB).eq(edited.slice(edit.fromB, edit.toB)))) continue;
        let cursor = edit.fromA;
        const deletions: [number, number][] = [];
        for (const other of remoteChanges) {
            if (other.toA < cursor || other.fromA > edit.toA) continue;
            if (other.fromA > cursor) deletions.push([cursor, Math.min(other.fromA, edit.toA)]);
            cursor = Math.max(cursor, other.toA);
        }
        if (cursor < edit.toA) deletions.push([cursor, edit.toA]);
        for (const [from, to] of deletions.reverse()) {
            const start = map(from, 1), end = map(to, -1);
            if (start < end) transform.delete(start, end);
        }
        if (edit.fromB < edit.toB) {
            const replaced = remoteChanges.find((other) => other.fromA <= edit.fromA && other.toA > edit.fromA);
            const position = replaced ? transform.mapping.map(replaced.toB, 1) : map(edit.fromA, 1);
            transform.replaceRange(position, position, edited.slice(edit.fromB, edit.toB));
        }
    }
    // Formatting changes on surviving baseline characters are independent of
    // text insertions. Apply only locally changed mark types, retaining remote
    // formatting of other types and all formatting on remote insertions.
    base.descendants((node, position) => {
        if (!node.isText) {
            const next = edited.nodeAt(localMap.map(position, 1));
            const target = transform.doc.nodeAt(map(position, 1));
            if (!next || !target || next.type !== node.type || target.type !== node.type) return;
            const attrs = { ...target.attrs };
            for (const key of Object.keys(next.attrs)) if (JSON.stringify(node.attrs[key]) !== JSON.stringify(next.attrs[key])) attrs[key] = next.attrs[key];
            if (JSON.stringify(attrs) !== JSON.stringify(target.attrs)) transform.setNodeMarkup(map(position, 1), undefined, attrs);
            return;
        }
        for (let offset = 0; offset < node.nodeSize; offset++) {
            const from = position + offset;
            if (localChanges.some((edit) => from >= edit.fromA && from < edit.toA) || remoteChanges.some((edit) => from >= edit.fromA && from < edit.toA)) continue;
            const localMarks = edited.resolve(localMap.map(from, 1)).nodeAfter?.marks || [];
            for (const type of new Set([...node.marks, ...localMarks].map((mark) => mark.type))) {
                const old = node.marks.find((mark) => mark.type === type), next = localMarks.find((mark) => mark.type === type);
                if (old && next && old.eq(next) || !old && !next) continue;
                const start = map(from, 1), end = map(from + 1, -1);
                if (start >= end) continue;
                transform.removeMark(start, end, type);
                if (next) transform.addMark(start, end, next);
            }
        }
    });
    transform.doc.check();
    return { richText: transform.doc.toJSON() as Record<string, unknown>, content: transform.doc.textBetween(0, transform.doc.content.size, "\n").trimEnd() };
}
