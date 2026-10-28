import { http } from "./request";

export type ReferralMode = "all" | "assigned";

export type ReferralSetting = {
    enabled: boolean;
    /** all：全民推广；assigned：仅后台指定的推广人。 */
    mode: ReferralMode;
    /** 返佣比例，万分比；1000 表示 10%。 */
    commissionRateBasisPoints: number;
};

export type ReferralStats = {
    inviteeCount: number;
    paidInviteeCount: number;
    commissionCount: number;
    orderAmountFen: number;
    commissionMicrocredits: number;
};

export type ReferralOverview = {
    code: string;
    mode: ReferralMode;
    commissionRateBasisPoints: number;
    stats: ReferralStats;
};

export type ReferralInvitee = { name: string; createdAt: string };

export type ReferralCommission = {
    id: string;
    inviterUserId?: string;
    inviterName?: string;
    inviteeName: string;
    orderAmountFen: number;
    orderCreditsMicrocredits: number;
    rateBasisPoints: number;
    commissionMicrocredits: number;
    createdAt: string;
};

type PageParams = { page?: number; pageSize?: number };
type Paged = { total: number; page: number; pageSize: number };

export function getReferralOverview() {
    return http.get<ReferralOverview>("/referral");
}

export function listReferralInvitees(params: PageParams = {}) {
    return http.get<Paged & { invitees: ReferralInvitee[] }>("/referral/invitees", { params });
}

export function listReferralCommissions(params: PageParams = {}) {
    return http.get<Paged & { commissions: ReferralCommission[] }>("/referral/commissions", { params });
}

export function getAdminReferralSetting() {
    return http.get<{ setting: ReferralSetting }>("/admin/settings/referral");
}

export function updateAdminReferralSetting(setting: ReferralSetting) {
    return http.patch<{ setting: ReferralSetting }>("/admin/settings/referral", setting);
}

export function listAdminReferralCommissions(params: PageParams = {}) {
    return http.get<Paged & { commissions: ReferralCommission[] }>("/admin/referral/commissions", { params });
}

/** 推广链接指向注册页；注册页读取 ref 参数并随注册请求提交。 */
export function referralLink(code: string, origin = window.location.origin) {
    return `${origin}/register?ref=${encodeURIComponent(code)}`;
}

export function formatReferralRate(basisPoints: number) {
    return `${(basisPoints / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

export function formatReferralCredits(microcredits: number) {
    return (microcredits / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function formatReferralYuan(fen: number) {
    return `¥${(fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
