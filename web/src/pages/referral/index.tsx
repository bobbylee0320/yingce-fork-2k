import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Skeleton } from "antd";
import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Navigate } from "react-router";
import { PageHeader, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { ApiError } from "@/services/api/request";
import { formatReferralCredits, formatReferralRate, formatReferralYuan, getReferralOverview, listReferralCommissions, listReferralInvitees, referralLink } from "@/services/api/referral";
import { useUserStore } from "@/stores/use-user-store";
import "./referral-page.css";

type RecordTab = "invitees" | "commissions";

const PAGE_SIZE = 20;

export default function ReferralPage() {
    const { message } = App.useApp();
    const referralAvailable = useUserStore((state) => state.referralAvailable);
    const hydrated = useUserStore((state) => state.hydrated);
    const [tab, setTab] = useState<RecordTab>("invitees");
    const [page, setPage] = useState(1);
    const overview = useQuery({ queryKey: ["referral", "overview"], queryFn: getReferralOverview, enabled: referralAvailable });
    const invitees = useQuery({ queryKey: ["referral", "invitees", page], queryFn: () => listReferralInvitees({ page, pageSize: PAGE_SIZE }), enabled: referralAvailable && tab === "invitees" });
    const commissions = useQuery({ queryKey: ["referral", "commissions", page], queryFn: () => listReferralCommissions({ page, pageSize: PAGE_SIZE }), enabled: referralAvailable && tab === "commissions" });

    // 入口不可见时直接访问 URL 也不展示页面；后端同样会拒绝。
    if (hydrated && !referralAvailable) return <Navigate to="/" replace />;
    const forbidden = overview.error instanceof ApiError && overview.error.status === 403;
    if (forbidden) return <Navigate to="/" replace />;

    const data = overview.data;
    const link = data ? referralLink(data.code) : "";
    const copy = async (value: string, label: string) => {
        try {
            await navigator.clipboard.writeText(value);
            message.success(`${label}已复制`);
        } catch {
            message.error("复制失败，请手动选择后复制");
        }
    };
    const refresh = () => {
        void overview.refetch();
        void (tab === "invitees" ? invitees.refetch() : commissions.refetch());
    };
    const records = tab === "invitees" ? invitees : commissions;
    const total = records.data?.total ?? 0;

    return (
        <WorkspacePage className="referral-page">
            <PageHeader
                title="推广中心"
                description="分享专属链接邀请新用户注册。被邀请用户在线充值积分后，你将按比例获得积分返佣。"
                actions={
                    <Button icon={<RefreshCw className="size-3.5" />} loading={overview.isFetching} onClick={refresh}>
                        刷新
                    </Button>
                }
            />
            <div className="mt-4 grid gap-4">
                {overview.isPending ? (
                    <Skeleton active paragraph={{ rows: 4 }} />
                ) : overview.error ? (
                    <div className="referral-page-link-card">
                        <p>{overview.error instanceof Error ? overview.error.message : "读取推广信息失败"}</p>
                        <div>
                            <Button onClick={() => void overview.refetch()}>重试</Button>
                        </div>
                    </div>
                ) : data ? (
                    <>
                        <section className="referral-page-link-card" aria-label="我的推广链接">
                            <h2>我的推广链接</h2>
                            <div className="referral-page-link-row">
                                <Input readOnly value={link} aria-label="推广链接" onFocus={(event) => event.currentTarget.select()} />
                                <Button type="primary" icon={<Copy className="size-3.5" />} onClick={() => void copy(link, "推广链接")}>
                                    复制链接
                                </Button>
                            </div>
                            <p>
                                推广码 <span className="referral-page-code font-semibold">{data.code}</span>
                                <Button type="link" size="small" onClick={() => void copy(data.code, "推广码")}>
                                    复制
                                </Button>
                                · 当前返佣比例 {formatReferralRate(data.commissionRateBasisPoints)}，按被邀请用户每笔积分充值到账数量计算，返佣以积分发放到你的账户。
                            </p>
                        </section>
                        <section className="referral-page-stats" aria-label="推广收益">
                            <Stat label="邀请注册" value={`${data.stats.inviteeCount} 人`} />
                            <Stat label="已充值用户" value={`${data.stats.paidInviteeCount} 人`} />
                            <Stat label="邀请充值金额" value={formatReferralYuan(data.stats.orderAmountFen)} />
                            <Stat label="累计返佣积分" value={formatReferralCredits(data.stats.commissionMicrocredits)} />
                        </section>
                    </>
                ) : null}
                <section className="referral-page-records" aria-label="推广记录">
                    <SegmentedControl<RecordTab>
                        ariaLabel="推广记录类型"
                        size="sm"
                        value={tab}
                        options={[
                            { value: "invitees", label: "邀请记录" },
                            { value: "commissions", label: "返佣记录" },
                        ]}
                        onChange={(next) => {
                            setTab(next);
                            setPage(1);
                        }}
                    />
                    <div className="mt-2">
                        {records.isPending ? (
                            <Skeleton active paragraph={{ rows: 3 }} title={false} />
                        ) : records.error ? (
                            <div className="referral-page-empty">{records.error instanceof Error ? records.error.message : "读取记录失败"}</div>
                        ) : tab === "invitees" ? (
                            invitees.data?.invitees.length ? (
                                invitees.data.invitees.map((item, index) => (
                                    <div key={`${item.createdAt}-${index}`} className="referral-page-record-row">
                                        <div>
                                            {item.name}
                                            <small>注册于 {formatTime(item.createdAt)}</small>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="referral-page-empty">还没有用户通过你的链接注册</div>
                            )
                        ) : commissions.data?.commissions.length ? (
                            commissions.data.commissions.map((item) => (
                                <div key={item.id} className="referral-page-record-row">
                                    <div>
                                        {item.inviteeName} 充值 {formatReferralYuan(item.orderAmountFen)}（{formatReferralCredits(item.orderCreditsMicrocredits)} 积分）
                                        <small>
                                            {formatTime(item.createdAt)} · 返佣比例 {formatReferralRate(item.rateBasisPoints)}
                                        </small>
                                    </div>
                                    <b>+{formatReferralCredits(item.commissionMicrocredits)}</b>
                                </div>
                            ))
                        ) : (
                            <div className="referral-page-empty">暂无返佣记录</div>
                        )}
                    </div>
                    {total > PAGE_SIZE ? <PaginationBar current={page} pageSize={PAGE_SIZE} total={total} pageSizeOptions={[PAGE_SIZE]} onChange={(next) => setPage(next)} /> : null}
                </section>
            </div>
        </WorkspacePage>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="referral-page-stat">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function formatTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
