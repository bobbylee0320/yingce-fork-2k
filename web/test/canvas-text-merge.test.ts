import { expect, test } from "bun:test";
import { canvasTextEdits, mergeCanvasRichText, mergeCanvasText } from "../src/lib/canvas/canvas-text-merge";

test("same-position typing keeps committed text followed by competing input", () => {
    expect(mergeCanvasText("镜头：", "镜头：推近", "镜头：升格")).toBe("镜头：推近升格");
    expect(mergeCanvasText("", "A", "B")).toBe("AB");
    expect(mergeCanvasText("hello", "hello!", "hello!")).toBe("hello!");
});

test("multiple edits and concurrent deletions do not remove the other device's insertion", () => {
    expect(mergeCanvasText("abcdef", "aBcdeF", "abCdEf")).toBe("aBCdEF");
    expect(mergeCanvasText("abcdef", "abXYcdef", "af")).toBe("aXYf");
    expect(mergeCanvasText("abc", "aRc", "aLc")).toBe("aRLc");
    expect(mergeCanvasText("abc", "ac", "ac")).toBe("ac");
    expect(mergeCanvasText("Original prompt", "Remote prompt", "Local prompt")).toBe("RemoteLocal prompt");
    expect(mergeCanvasText("Original prompt", "Remote prompt", "Local! prompt")).toBe("RemoteLocal! prompt");
});

test("emoji replacements keep complete Unicode characters", () => {
    expect(mergeCanvasText("🍎", "🍏", "🍊")).toBe("🍏🍊");
    expect(mergeCanvasText("x😀y", "x😄y", "x😃y")).toBe("x😄😃y");
});

test("a pending draft merged against an advanced baseline does not duplicate remote text", () => {
    const merged = mergeCanvasText("", "A", "B");
    expect(merged).toBe("AB");
    expect(mergeCanvasText("A", "AC", merged + "D")).toBe("ACBD");
    expect(mergeCanvasText("AC", "AC", "ACBD")).toBe("ACBD");
});

test("large documents keep distant modifications and diff applies exactly", () => {
    const base = "0123456789\n".repeat(10000);
    const remote = base.slice(0, 5) + "甲" + base.slice(5);
    const local = base.slice(0, -5) + "乙" + base.slice(-5);
    expect(mergeCanvasText(base, remote, local)).toBe(remote.slice(0, -5) + "乙" + remote.slice(-5));
    for (const [before, after] of [["🍎🍏😀", "🍋🍏😃"], ["abcdef", "aBcdeF"], ["", "abc"], ["abc", ""]]) {
        let applied = before!;
        for (const edit of canvasTextEdits(before!, after!).reverse()) applied = applied.slice(0, edit.from) + edit.insert + applied.slice(edit.to);
        expect(applied).toBe(after!);
    }
});

const rich = (text: string, marks: { type: string }[] = []) => ({ type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text, ...(marks.length ? { marks } : {}) }] : [] }] });

test("rich text concurrent typing retains text, structure and both insertions' formatting", () => {
    const merged = mergeCanvasRichText(rich(""), rich("甲", [{ type: "bold" }]), rich("乙", [{ type: "italic" }]));
    expect(merged.content).toBe("甲乙");
    expect(merged.richText).toMatchObject({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "甲", marks: [{ type: "bold" }] }, { type: "text", text: "乙", marks: [{ type: "italic" }] }] }] });
});

test("rich text local deletion preserves concurrent inserted text and remote formatting", () => {
    const merged = mergeCanvasRichText(rich("abcdef"), rich("abXYcdef", [{ type: "bold" }]), rich("af"));
    expect(merged.content).toBe("aXYf");
    expect(merged.richText).toMatchObject(rich("aXYf", [{ type: "bold" }]));
});

test("independent mark edits merge without duplicating unchanged text", () => {
    const merged = mergeCanvasRichText(rich("abc"), rich("abc", [{ type: "bold" }]), rich("abc", [{ type: "italic" }]));
    expect(merged.content).toBe("abc");
    expect(merged.richText).toMatchObject(rich("abc", [{ type: "bold" }, { type: "italic" }]));
});

test("rich text emoji replacements and paragraph additions preserve valid documents", () => {
    expect(mergeCanvasRichText(rich("x😀y"), rich("x😄y"), rich("x😃y")).content).toBe("x😄😃y");
    const base = rich("start");
    const remote = { ...base, content: [...base.content, ...rich("甲").content] };
    const local = { ...base, content: [...base.content, ...rich("乙").content] };
    expect(mergeCanvasRichText(base, remote, local).content).toBe("start\n甲\n乙");
});

test("local block formatting survives a remote text insertion", () => {
    const local = { type: "doc", content: [{ ...rich("abc").content[0], attrs: { textAlign: "center" } }] };
    expect(mergeCanvasRichText(rich("abc"), rich("abc远"), local).richText).toMatchObject({ content: [{ attrs: { textAlign: "center" } }] });
});
