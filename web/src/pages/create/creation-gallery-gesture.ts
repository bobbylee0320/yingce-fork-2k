/** 每次有意滚动切换一张；惯性衰减不翻页，再次发力无需等待惯性完全停止。 */
export function createGalleryWheelGesture() {
    let lastAt = -Infinity;
    let steppedAt = -Infinity;
    let lastDirection = 0;
    let lastMagnitude = 0;
    let peak = 0;
    let total = 0;
    let stepped = false;

    return (delta: number, now: number): -1 | 0 | 1 => {
        const magnitude = Math.abs(delta);
        if (magnitude < 0.5) return 0;
        const direction = delta > 0 ? 1 : -1;
        const idle = now - lastAt >= 160;
        const reversed = direction !== lastDirection;
        const renewed = stepped && now - steppedAt >= 180
            && lastMagnitude < peak * 0.6
            && magnitude >= Math.max(8, lastMagnitude * 1.8);
        if (idle || reversed || renewed) {
            total = 0;
            peak = 0;
            stepped = false;
        }
        lastAt = now;
        lastDirection = direction;
        lastMagnitude = magnitude;
        peak = Math.max(peak, magnitude);
        total += magnitude;
        if (stepped || total < 8) return 0;
        stepped = true;
        steppedAt = now;
        return direction;
    };
}
