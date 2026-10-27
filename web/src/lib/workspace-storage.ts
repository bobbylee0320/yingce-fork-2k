import { openWorkspaceWallet } from "@/lib/workspace-wallet";

/** 打开积分中心 · 充值，并定位到存储空间套餐。 */
export function openStoragePurchase() {
    openWorkspaceWallet({ tab: "topup", category: "storage" });
}

/** 已超出容量或只读的错误原因，前端据此展示扩容入口。 */
export const STORAGE_LIMIT_REASONS = new Set(["storage_capacity_exceeded", "storage_read_only"]);
