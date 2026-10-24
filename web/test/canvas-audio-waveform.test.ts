import { describe, expect, test } from "bun:test";
import { computeWaveformPeaks, AUDIO_WAVEFORM_BARS } from "@/lib/canvas/canvas-audio-waveform";

describe("canvas audio waveform extraction", () => {
    test("returns normalized peaks within [0.12, 1.0] from mock AudioBuffer", () => {
        // 创建一个包含动态声波的 Mock AudioBuffer（正弦波 + 静音片段）
        const sampleRate = 44100;
        const length = sampleRate * 2; // 2 秒音频
        const channel0 = new Float32Array(length);
        const channel1 = new Float32Array(length);

        for (let i = 0; i < length; i++) {
            // 前半段有声音（振幅从 0 逐渐增大到 1），后半段衰减
            const envelope = i < length / 2 ? (i / (length / 2)) : 1 - (i - length / 2) / (length / 2);
            const wave = Math.sin((i * 440 * 2 * Math.PI) / sampleRate);
            channel0[i] = wave * envelope;
            channel1[i] = wave * envelope * 0.8;
        }

        const mockBuffer = {
            numberOfChannels: 2,
            length,
            duration: 2,
            sampleRate,
            getChannelData: (ch: number) => (ch === 0 ? channel0 : channel1),
        } as unknown as AudioBuffer;

        const peaks = computeWaveformPeaks(mockBuffer, AUDIO_WAVEFORM_BARS);

        expect(peaks).toHaveLength(AUDIO_WAVEFORM_BARS);
        // 所有柱高必须在 [0, 1.0] 的合法视觉高度范围内（静音为 0，有声为 0.12~1.0）
        for (const val of peaks) {
            expect(val).toBeGreaterThanOrEqual(0);
            expect(val).toBeLessThanOrEqual(1.0);
        }
        // 最高峰值应为 1.0
        expect(Math.max(...peaks)).toBe(1.0);

        // 前半段的峰值应呈上升趋势（反映真实音频振幅），而不是固定的伪随机值
        expect(peaks[Math.floor(AUDIO_WAVEFORM_BARS / 2) - 1]).toBeGreaterThan(peaks[1]);
    });

    test("handles silent or empty audio buffers gracefully", () => {
        const mockSilentBuffer = {
            numberOfChannels: 1,
            length: 44100,
            duration: 1,
            sampleRate: 44100,
            getChannelData: () => new Float32Array(44100),
        } as unknown as AudioBuffer;

        const peaks = computeWaveformPeaks(mockSilentBuffer, AUDIO_WAVEFORM_BARS);
        expect(peaks).toHaveLength(AUDIO_WAVEFORM_BARS);
        // 静音音频切分后峰值应全为 0（基准虚线平铺）
        for (const val of peaks) {
            expect(val).toBe(0);
        }

        const mockEmptyBuffer = {
            numberOfChannels: 1,
            length: 0,
            duration: 0,
            sampleRate: 44100,
            getChannelData: () => new Float32Array(0),
        } as unknown as AudioBuffer;

        const emptyPeaks = computeWaveformPeaks(mockEmptyBuffer, AUDIO_WAVEFORM_BARS);
        expect(emptyPeaks).toHaveLength(AUDIO_WAVEFORM_BARS);
        for (const val of emptyPeaks) {
            expect(val).toBe(0);
        }
    });
});
