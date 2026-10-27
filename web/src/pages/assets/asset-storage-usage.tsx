import { HardDrive } from "lucide-react";

import { useAccountFileStorageUsage } from "@/hooks/use-account-file-storage-usage";
import { accountFileStorageUsageQueryKey, accountStorageMeter, accountStorageStateMessage, formatStorageBytes } from "@/lib/account-storage-usage";
import { openStoragePurchase } from "@/lib/workspace-storage";
import { progressFillStyle } from "@/lib/progress-fill";

export const assetStorageUsageQueryKey = accountFileStorageUsageQueryKey;

export function AssetStorageUsage() {
    const query = useAccountFileStorageUsage();
    const usage = query.data;
    const meter = accountStorageMeter(usage);
    const stateMessage = accountStorageStateMessage(meter);
    const showUpsell = meter.state !== "ok" || meter.tone !== "ok";

    return (
        <section
            className={`assets-storage-usage${meter.full || meter.state !== "ok" ? " is-full" : ""}${usage?.usedBytes ? " has-usage" : ""}`}
            aria-label="账号文件容量"
            aria-busy={query.isPending}
            title={`包含素材文件和 Agent 会话附件${stateMessage ? `。${stateMessage}` : ""}`}
        >
            <span className="assets-storage-usage-icon" aria-hidden="true">
                <HardDrive />
            </span>
            <span className="assets-storage-usage-title">{meter.state === "read_only" ? "账号只读" : meter.state === "grace" ? "容量已超额" : "账号容量"}</span>
            {usage ? (
                <>
                    <span className="assets-storage-usage-value">
                        {formatStorageBytes(usage.usedBytes)} / {formatStorageBytes(usage.totalBytes)}
                    </span>
                    <span
                        className="assets-storage-usage-track"
                        role="progressbar"
                        aria-label="账号文件容量使用进度"
                        aria-valuemin={0}
                        aria-valuemax={usage.totalBytes}
                        aria-valuenow={Math.min(usage.usedBytes, usage.totalBytes)}
                        aria-valuetext={`已使用 ${formatStorageBytes(usage.usedBytes)}，总容量 ${formatStorageBytes(usage.totalBytes)}`}
                    >
                        <span style={progressFillStyle(meter.percent)} />
                    </span>
                    <span className="assets-storage-usage-percent">{meter.percentLabel}</span>
                    <button type="button" className="assets-storage-usage-action" onClick={() => openStoragePurchase()}>
                        {showUpsell ? "扩容" : "购买空间"}
                    </button>
                </>
            ) : query.isError ? (
                <span className="assets-storage-usage-status">
                    容量统计暂时不可用。
                    <button type="button" onClick={() => void query.refetch()}>
                        重试
                    </button>
                </span>
            ) : (
                <span className="assets-storage-usage-status">正在统计已用容量…</span>
            )}
        </section>
    );
}
