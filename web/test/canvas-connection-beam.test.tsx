import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasConnectionBeam, ConnectionPath } from "../src/components/canvas/canvas-connections";
import { CANVAS_CONNECTION_STROKE_WIDTH, canvasThemes } from "../src/lib/canvas-theme";
import { CanvasNodeType } from "../src/types/canvas";

const from = { id: "from", title: "来源", type: CanvasNodeType.Text, position: { x: 0, y: 0 }, width: 200, height: 100 };
const to = { ...from, id: "to", position: { x: 500, y: 200 } };
const connection = { id: "edge", fromNodeId: from.id, toNodeId: to.id };

function render(active: boolean, hideVisual = false) {
    return renderToStaticMarkup(<ConnectionPath connection={connection} from={from} to={to} active={active} hideVisual={hideVisual} visualMode="hover-only" onSelect={() => {}} />);
}

test("focusing a node displays beams even without hovering the connection", () => {
    expect(render(true)).toContain("data-connection-beam");
    expect(render(false)).not.toContain("data-connection-beam");
});

test("dragging hides static beams while preserving the connection hit target", () => {
    const markup = render(true, true);
    expect(markup).not.toContain("data-connection-beam");
    expect(markup).toContain('data-connection-id="edge"');
    expect(markup).toContain('stroke-width="16"');
});

test("both themes use neutral gray droplets with zoom-compensated widths", () => {
    for (const theme of [canvasThemes.light, canvasThemes.dark]) {
        const rgb = theme.connection.beam.match(/[a-f0-9]{2}/gi)!;
        expect(new Set(rgb).size).toBe(1);
        const markup = renderToStaticMarkup(<CanvasConnectionBeam pathD="M 0 0 C 100 0 100 200 200 200" color={theme.connection.beam} />);
        expect(markup).toContain(`stroke="${theme.connection.beam}"`);
        expect(markup).toContain(`stroke-width="${CANVAS_CONNECTION_STROKE_WIDTH}"`);
        expect(markup).toContain("pointer-events:none");
        expect(markup).toContain(`stroke-width:calc(${CANVAS_CONNECTION_STROKE_WIDTH}px / var(--canvas-committed-scale, 1))`);
        expect(markup).toContain("stroke-width:calc(2.1px / var(--canvas-committed-scale, 1))");
    }
});

test("droplet layers share the same leading edge and thicken from tail to head", () => {
    const markup = renderToStaticMarkup(<CanvasConnectionBeam pathD="M 0 0 L 300 0" color={canvasThemes.light.connection.beam} />);
    const layers = [...markup.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/g)];
    expect(layers).toHaveLength(8);
    for (const [, length, gap, offset] of layers) {
        expect(Number(length) + Number(gap)).toBe(100);
        expect(Number(length) - Number(offset)).toBe(36);
    }
    const widths = [...markup.matchAll(/stroke-width="([\d.]+)"/g)].map((match) => Number(match[1]));
    const opacities = [...markup.matchAll(/stroke-opacity="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(widths[widths.length - 1]).toBeGreaterThan(widths[0] * 5);
    expect(widths[widths.length - 1]).toBeLessThanOrEqual(2.1);
    for (let index = 1; index < widths.length; index++) {
        expect(widths[index]).toBeGreaterThan(widths[index - 1]);
        expect(widths[index] - widths[index - 1]).toBeLessThanOrEqual(0.31);
        expect(opacities[index]).toBeGreaterThan(opacities[index - 1]);
    }
    expect(markup).toContain("--canvas-beam-offset:-28px");
    expect(markup).toContain('stroke-linecap="round"');
});
