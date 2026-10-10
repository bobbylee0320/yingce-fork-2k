import { MAX_LAYER_PIXELS } from "@/lib/canvas/canvas-image-layers";
import { latestImageLayerPlan } from "@/lib/canvas/canvas-image-layer-plan";
import { listGenerationTasks, queryGenerationTask } from "@/services/api/task-center";
import { getImageBlob } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

/** 列表只有安全摘要，按源节点筛选后通过已有鉴权详情接口读取计划。 */
export async function readImageLayerPlanningHistory(projectId: string, sourceNodeId: string, sourceStorageKey: string | undefined, signal: AbortSignal) {
    const tasks = await listGenerationTasks(50, { projectId }, undefined, signal);
    const candidates = tasks
        .filter((task) => task.projectId === projectId && task.type === "canvas_text" && task.status === "succeeded" && task.clientContext?.nodeId?.startsWith(`${sourceNodeId}-layer-plan-`))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const summary of candidates) {
        signal.throwIfAborted();
        const task = await queryGenerationTask(summary.id, { signal });
        signal.throwIfAborted();
        const plan = latestImageLayerPlan([task], projectId, sourceNodeId, sourceStorageKey);
        if (plan) return plan;
    }
    throw new Error("最近 50 条任务中没有这张源图的可用规划，请重新识图或关闭规划后手工填写目标");
}

/** 只预处理识图输入，最终拆层仍使用完整源图；读取和上传沿用账号资源链路。 */
export async function prepareImageLayerPlanningReference(source: ReferenceImage, input: "preview" | "original", signal: AbortSignal) {
    signal.throwIfAborted();
    let blob = source.storageKey ? await getImageBlob(source.storageKey) : null;
    signal.throwIfAborted();
    if (!blob) {
        const response = await fetch(source.url || source.dataUrl, { signal });
        if (!response.ok) throw new Error("无法读取识图源图，请重新上传图片");
        blob = await response.blob();
    }
    signal.throwIfAborted();
    const bitmap = await createImageBitmap(blob);
    try {
        signal.throwIfAborted();
        const sourceSize = { width: bitmap.width, height: bitmap.height };
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_LAYER_PIXELS) throw new Error("识图源图尺寸无效或超过处理上限");
        if (input === "original" || Math.max(bitmap.width, bitmap.height) <= 1000) return { reference: { ...source, ...sourceSize }, sourceSize };
        const ratio = 1000 / Math.max(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        try {
            const context = canvas.getContext("2d");
            if (!context) throw new Error("浏览器不支持识图预览，请选择原图输入");
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const type = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
            const dataUrl = canvas.toDataURL(type, 0.92);
            if (!dataUrl.startsWith(`data:${type};base64,`)) throw new Error("识图预览编码失败，请选择原图输入");
            signal.throwIfAborted();
            const reference: ReferenceImage = { id: source.id, name: `layer-plan-${source.id}.${type === "image/jpeg" ? "jpg" : "png"}`, type, dataUrl, width: canvas.width, height: canvas.height };
            return { reference, sourceSize };
        } finally {
            canvas.width = canvas.height = 0;
        }
    } finally {
        bitmap.close();
    }
}
