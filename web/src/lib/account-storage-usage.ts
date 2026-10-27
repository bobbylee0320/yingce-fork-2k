import { formatBytes } from "@/lib/image-utils";
import type { AccountFileStorageUsage } from "@/services/api/resources";

export const accountFileStorageUsageQueryKey = ["account-file-storage-usage"] as const;

export type AccountStorageTone = "ok" | "warn" | "critical";

/** ok：容量内；grace：已超额、宽限期内只禁止上传和生成；read_only：宽限期结束后只读。 */
export type AccountStorageState = "ok" | "grace" | "read_only";

export type AccountStorageMeter = {
    percent: number;
    remainingBytes: number;
    usedLabel: string;
    totalLabel: string;
    baseLabel: string;
    purchasedLabel: string;
    remainingLabel: string;
    percentLabel: string;
    tone: AccountStorageTone;
    full: boolean;
    state: AccountStorageState;
    /** 宽限期内显示进入只读的时间。 */
    readOnlyAtLabel: string;
    nextExpiresAtLabel: string;
};

export function formatStorageBytes(value: number) {
    return formatBytes(value) || "0 B";
}

/** 容量按整 GB 售卖，展示时去掉多余小数。 */
export function formatStorageCapacity(bytes: number) {
    const gigabytes = bytes / 1024 ** 3;
    if (gigabytes >= 1024 && Number.isInteger(gigabytes / 1024)) return `${gigabytes / 1024} TB`;
    if (Number.isInteger(gigabytes)) return `${gigabytes} GB`;
    return formatStorageBytes(bytes);
}

export function formatStorageDuration(days: number) {
    if (!days) return "永久有效";
    if (days % 365 === 0) return `${days / 365} 年`;
    if (days % 30 === 0) return `${days / 30} 个月`;
    return `${days} 天`;
}

export function formatStorageDate(value?: string) {
    return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

export function accountStorageMeter(usage?: AccountFileStorageUsage | null): AccountStorageMeter {
    const usedBytes = usage && Number.isFinite(usage.usedBytes) ? Math.max(0, usage.usedBytes) : 0;
    const totalBytes = usage && Number.isFinite(usage.totalBytes) ? Math.max(0, usage.totalBytes) : 0;
    const remainingBytes = Math.max(0, totalBytes - usedBytes);
    const percent = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;
    const full = totalBytes > 0 && usedBytes >= totalBytes;
    const tone: AccountStorageTone = full || percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";
    const state: AccountStorageState = usage?.readOnly ? "read_only" : usage?.overLimit ? "grace" : "ok";

    return {
        percent,
        remainingBytes,
        usedLabel: formatStorageBytes(usedBytes),
        totalLabel: formatStorageBytes(totalBytes),
        baseLabel: formatStorageCapacity(usage?.baseBytes ?? totalBytes),
        purchasedLabel: usage?.purchasedBytes ? formatStorageCapacity(usage.purchasedBytes) : "",
        remainingLabel: formatStorageBytes(remainingBytes),
        percentLabel: usedBytes && percent < 0.1 ? "<0.1%" : `${Math.round(percent * 10) / 10}%`,
        tone,
        full,
        state,
        readOnlyAtLabel: formatStorageDate(usage?.readOnlyAt),
        nextExpiresAtLabel: formatStorageDate(usage?.nextExpiresAt),
    };
}

/** 超额提示文案，侧栏、素材页和扩容弹窗共用。 */
export function accountStorageStateMessage(meter: AccountStorageMeter) {
    if (meter.state === "read_only") return "已超出容量且宽限期已结束，账号处于只读状态。删除素材或购买空间后恢复。";
    if (meter.state === "grace") return `已超出容量，暂停上传和生成。${meter.readOnlyAtLabel ? `${meter.readOnlyAtLabel} 后` : "宽限期结束后"}将进入只读状态。`;
    if (meter.full) return "容量已满，暂停上传和生成。";
    return "";
}
