import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box3, Vector3, type Object3D } from "three";
import { GLTFLoader } from "three-stdlib";

import { buildPrevisMannequin, isPrevisStandardActor, resolvePrevisMannequinProfile } from "../src/lib/canvas/previs/previs-mannequin";
import { evaluatePrevisActorPose, PREVIS_MANNEQUIN_BONES, PREVIS_MANNEQUIN_POSES, PREVIS_MOTION_IDS, PREVIS_MOTIONS, previsHorizontalSpeed, previsMotionWeight, previsMotionsOverlap } from "../src/lib/canvas/previs/previs-motion";
import { createPrevisActor } from "../src/lib/canvas/previs/previs-scene";
import type { PrevisKeyframe, PrevisObject, PrevisPose, PrevisVec3 } from "../src/types/previs";

const frame = (time: number, position: PrevisVec3): PrevisKeyframe => ({ id: `k${time}`, time, easing: "linear", transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] } });

// 与运行时同一份本地 GLB（public/previs/mannequin.glb），测试不依赖网络。
let template: Object3D;
beforeAll(async () => {
    const file = readFileSync(join(import.meta.dir, "../public/previs/mannequin.glb"));
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    template = await new Promise<Object3D>((resolve, reject) => new GLTFLoader().parse(buffer, "", (gltf) => resolve(gltf.scene), reject));
});

function build(archetype: PrevisObject["archetype"] = "adult") {
    const profile = resolvePrevisMannequinProfile(archetype);
    return buildPrevisMannequin({ template, archetype, profile, color: "#2f7de1", castShadow: true, receiveShadow: true });
}

function bounds(root: { updateMatrixWorld: (force?: boolean) => void }) {
    root.updateMatrixWorld(true);
    return new Box3().setFromObject(root as never, true);
}

describe("标准人偶路由", () => {
    test("工作台新建、Agent 新建（primitive=character）与旧 CDN 地址都走标准人偶", () => {
        expect(isPrevisStandardActor(createPrevisActor("A"))).toBe(true);
        expect(isPrevisStandardActor({ kind: "actor", primitive: "character" })).toBe(true);
        expect(isPrevisStandardActor({ kind: "actor", url: "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/examples/models/gltf/Xbot.glb" })).toBe(true);
    });

    test("用户上传的模型保留 GLB 渲染，普通几何体不受影响", () => {
        expect(isPrevisStandardActor({ kind: "actor", url: "blob:local", assetId: "asset-1" })).toBe(false);
        expect(isPrevisStandardActor({ kind: "actor", storageKey: "media/1" })).toBe(false);
        expect(isPrevisStandardActor({ kind: "primitive", primitive: "box" })).toBe(false);
    });

    test("新建演员不再依赖 CDN", () => {
        expect(createPrevisActor("A").url).toBeUndefined();
    });
});

describe("标准人偶骨架与贴地", () => {
    test("骨架包含全部主干骨骼，rig 一一映射", () => {
        const mannequin = build();
        for (const bone of PREVIS_MANNEQUIN_BONES) {
            expect(mannequin.bones[bone].name).toBe(bone);
            expect(mannequin.rig.boneMap[bone]).toBe(bone);
        }
        expect(mannequin.rig.status).toBe("ready");
        mannequin.dispose();
    });

    test("站立时脚底贴地、成人身高约 1.8m", () => {
        const mannequin = build();
        mannequin.applyPose(evaluatePrevisActorPose({ pose: "stand", keyframes: [] }, 0));
        const box = bounds(mannequin.root);
        expect(box.min.y).toBeGreaterThan(-0.03);
        expect(box.min.y).toBeLessThan(0.03);
        expect(box.max.y).toBeGreaterThan(1.65);
        expect(box.max.y).toBeLessThan(1.95);
        mannequin.dispose();
    });

    test("儿童明显矮于成人", () => {
        const adult = build("adult");
        const child = build("child");
        const pose = evaluatePrevisActorPose({ pose: "stand", keyframes: [] }, 0);
        adult.applyPose(pose);
        child.applyPose(pose);
        expect(bounds(child.root).max.y).toBeLessThan(bounds(adult.root).max.y * 0.85);
        adult.dispose();
        child.dispose();
    });

    test("21 个姿势全部有限、贴地，蹲坐跪会降低身体", () => {
        const mannequin = build();
        const heights = new Map<PrevisPose, number>();
        for (const pose of Object.keys(PREVIS_MANNEQUIN_POSES) as PrevisPose[]) {
            const evaluated = evaluatePrevisActorPose({ pose, keyframes: [] }, 0);
            for (const bone of PREVIS_MANNEQUIN_BONES) expect(evaluated.rotations[bone].every(Number.isFinite)).toBe(true);
            mannequin.applyPose(evaluated);
            const box = bounds(mannequin.root);
            expect(Math.abs(box.min.y)).toBeLessThan(0.04);
            heights.set(pose, box.max.y);
        }
        const stand = heights.get("stand")!;
        for (const pose of ["sit", "squat", "kneel_double"] as PrevisPose[]) expect(heights.get(pose)!).toBeLessThan(stand - 0.25);
        mannequin.dispose();
    });

    test("人偶面朝 +Z：脚尖在脚跟之前", () => {
        const mannequin = build();
        mannequin.applyPose(evaluatePrevisActorPose({ pose: "stand", keyframes: [] }, 0));
        const toe = mannequin.root.getObjectByName("DEF-toeL")!.getWorldPosition(new Vector3());
        const foot = mannequin.joints.leftFoot.getWorldPosition(new Vector3());
        expect(toe.z).toBeGreaterThan(foot.z + 0.08);
        mannequin.dispose();
    });

    test("T-pose 已校正：站立时双臂下垂、手在腰侧", () => {
        const mannequin = build();
        mannequin.applyPose(evaluatePrevisActorPose({ pose: "stand", keyframes: [] }, 0));
        for (const side of ["left", "right"] as const) {
            const shoulder = mannequin.joints[`${side}UpperArm`].getWorldPosition(new Vector3());
            const hand = mannequin.joints[`${side}Hand`].getWorldPosition(new Vector3());
            expect(hand.y).toBeLessThan(shoulder.y - 0.4);
            expect(Math.abs(hand.x)).toBeLessThan(0.45);
        }
        // 左手在 +X 侧
        expect(mannequin.joints.leftHand.getWorldPosition(new Vector3()).x).toBeGreaterThan(0);
        mannequin.dispose();
    });

    test("重定向作用到蒙皮关节：招手抬起右手", () => {
        const mannequin = build();
        mannequin.applyPose(evaluatePrevisActorPose({ pose: "stand", keyframes: [] }, 0));
        const rest = mannequin.joints.rightHand.getWorldPosition(new Vector3()).y;
        mannequin.applyPose(evaluatePrevisActorPose({ pose: "wave", keyframes: [] }, 0));
        const raised = mannequin.joints.rightHand.getWorldPosition(new Vector3()).y;
        const leftRaised = mannequin.joints.leftHand.getWorldPosition(new Vector3()).y;
        expect(Math.max(raised, leftRaised)).toBeGreaterThan(rest + 0.4);
        mannequin.dispose();
    });
});

describe("分层动作求值", () => {
    const walkPath = [frame(0, [0, 0, 0]), frame(2, [0, 0, 2.8])];

    test("按位移推导速度：1.4m/s 步行", () => {
        expect(previsHorizontalSpeed(walkPath, 1)).toBeCloseTo(1.4, 2);
        expect(previsHorizontalSpeed(walkPath, 3)).toBeCloseTo(0, 5);
    });

    test("移动时自动迈步，静止时不迈步", () => {
        const object = { pose: "stand" as const, keyframes: walkPath };
        expect(evaluatePrevisActorPose(object, 1).locomotion).toBe("walk");
        expect(evaluatePrevisActorPose(object, 3).locomotion).toBe("still");
        // 不同时刻腿的相位不同：确实在迈步而不是僵直滑行。
        const a = evaluatePrevisActorPose(object, 0.6).rotations.leftUpperLeg;
        const b = evaluatePrevisActorPose(object, 1.1).rotations.leftUpperLeg;
        expect(Math.abs(a[0] - b[0])).toBeGreaterThan(0.05);
    });

    test("高速移动切换为跑步", () => {
        const sprint = [frame(0, [0, 0, 0]), frame(2, [0, 0, 8])];
        expect(evaluatePrevisActorPose({ pose: "stand", keyframes: sprint }, 1).locomotion).toBe("run");
    });

    test("上半身动作叠加在走路上，不改动腿部", () => {
        const plain = evaluatePrevisActorPose({ pose: "stand", keyframes: walkPath }, 1);
        const waving = evaluatePrevisActorPose({ pose: "stand", keyframes: walkPath, motions: [{ id: "m", motion: "wave", start: 0, duration: 2 }] }, 1);
        expect(waving.rotations.leftUpperLeg).toEqual(plain.rotations.leftUpperLeg);
        expect(waving.rotations.rightUpperArm).not.toEqual(plain.rotations.rightUpperArm);
    });

    test("片段区间外无影响、两端淡入淡出", () => {
        const motion = { start: 1, duration: 2 };
        expect(previsMotionWeight(motion, 0.5)).toBe(0);
        expect(previsMotionWeight(motion, 1.1)).toBeCloseTo(0.5, 5);
        expect(previsMotionWeight(motion, 2)).toBe(1);
        expect(previsMotionWeight(motion, 3.5)).toBe(0);
    });

    test("骨骼覆盖与骨骼关键帧优先级高于动作", () => {
        const override: [number, number, number, number] = [0, 0, 0.3826834, 0.9238795];
        const result = evaluatePrevisActorPose({ pose: "wave", keyframes: [], boneOverrides: { rightUpperArm: override } }, 0);
        expect(result.rotations.rightUpperArm).toEqual(override);
    });

    test("所有动作在任意时刻都产出有限旋转", () => {
        // 与后端 cloudAgentPrevisMotionIDs 一一对应：Agent 能写的动作，前端必须都能求值。
        const backend = readFileSync(join(import.meta.dir, "../../backend/internal/app/cloud_agent_previs_mutation.go"), "utf8");
        const backendIds = /var cloudAgentPrevisMotionIDs = \[\]string\{([^}]*)\}/
            .exec(backend)?.[1]
            .match(/"([a-z_]+)"/g)
            ?.map((item) => item.slice(1, -1));
        expect(backendIds).toEqual([...PREVIS_MOTION_IDS]);
        for (const motion of PREVIS_MOTION_IDS) {
            const definition = PREVIS_MOTIONS[motion];
            for (const t of [0, 0.37, definition.duration / 2, definition.duration]) {
                const result = evaluatePrevisActorPose({ pose: "stand", keyframes: [], motions: [{ id: "m", motion, start: 0, duration: definition.duration }] }, t);
                for (const bone of PREVIS_MANNEQUIN_BONES) expect(result.rotations[bone].every(Number.isFinite)).toBe(true);
                expect(Number.isFinite(result.lift)).toBe(true);
            }
        }
    });

    test("同层动作重叠检测", () => {
        const existing = [{ id: "a", motion: "wave" as const, start: 0, duration: 2 }];
        expect(previsMotionsOverlap(existing, { motion: "nod", start: 1, duration: 1 })).toBe(true);
        expect(previsMotionsOverlap(existing, { motion: "nod", start: 2.5, duration: 1 })).toBe(false);
        expect(previsMotionsOverlap(existing, { motion: "jump", start: 1, duration: 1 })).toBe(false);
    });
});
