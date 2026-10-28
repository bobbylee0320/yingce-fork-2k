import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, InputNumber } from "antd";
import { Gift, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { SegmentedControl } from "@/components/ui/base/segmented-control";
import { PaginationBar } from "@/components/layout/workspace-page";
import { formatReferralCredits, formatReferralRate, formatReferralYuan, getAdminReferralSetting, listAdminReferralCommissions, updateAdminReferralSetting, type ReferralCommission, type ReferralMode, type ReferralSetting } from "@/services/api/referral";
import { AdminPageFrame } from "../components/admin-shell";
import { AdminDataTable, AdminTableEmpty, SettingsSectionCard } from "../components/admin-ui";
import { Switch } from "../ui/controls";

const PAGE_SIZE = 20;

export default function AdminReferralPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const setting = useQuery({ queryKey: ["admin", "referral", "setting"], queryFn: async () => (await getAdminReferralSetting()).setting });
    const [draft, setDraft] = useState<ReferralSetting | null>(null);
    const [saving, setSaving] = useState(false);
    const [page, setPage] = useState(1);
    const commissions = useQuery({ queryKey: ["admin", "referral", "commissions", page], queryFn: () => listAdminReferralCommissions({ page, pageSize: PAGE_SIZE }) });

    useEffect(() => {
        if (setting.data) setDraft(setting.data);
    }, [setting.data]);

    const dirty = Boolean(draft && setting.data && (draft.enabled !== setting.data.enabled || draft.mode !== setting.data.mode || draft.commissionRateBasisPoints !== setting.data.commissionRateBasisPoints));
    const save = async () => {
        if (!draft) return;
        setSaving(true);
        try {
            const result = await updateAdminReferralSetting(draft);
            queryClient.setQueryData(["admin", "referral", "setting"], result.setting);
            setDraft(result.setting);
            message.success("推广设置已保存，用户刷新页面后入口随之更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存推广设置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <AdminPageFrame
            title="推广中心"
            description="选择全民推广或只开放给指定推广人，并设置被邀请用户积分充值的返佣比例。"
            scroll
            actions={
                <Button icon={<RefreshCw className="size-3.5" />} loading={setting.isFetching || commissions.isFetching} onClick={() => void Promise.all([setting.refetch(), commissions.refetch()])}>
                    刷新
                </Button>
            }
        >
            <div className="admin-settings-stack">
                <SettingsSectionCard
                    icon={<Gift className="size-4" />}
                    title="推广设置"
                    description="指定推广人模式下，在「用户管理」编辑用户并打开「推广人」开关。"
                    status={setting.data ? { label: setting.data.enabled ? "已开启" : "已关闭", color: setting.data.enabled ? "success" : undefined } : undefined}
                    footer={
                        <>
                            <span className="text-xs text-foreground/55">返佣按被邀请用户每笔积分充值到账数量计算，以积分发放给推广人；存储空间订单不返佣。</span>
                            <Button type="primary" icon={<Save className="size-3.5" />} loading={saving} disabled={!dirty} onClick={() => void save()}>
                                保存
                            </Button>
                        </>
                    }
                >
                    {setting.error ? (
                        <div className="px-3 py-3 text-sm" role="alert">
                            {setting.error instanceof Error ? setting.error.message : "读取推广设置失败"}
                            <Button type="link" onClick={() => void setting.refetch()}>
                                重试
                            </Button>
                        </div>
                    ) : !draft ? (
                        <div className="px-3 py-3 text-sm text-foreground/55">读取中…</div>
                    ) : (
                        <div className="grid gap-4 px-3 py-3">
                            <label className="flex items-center justify-between gap-3">
                                <span>
                                    <strong className="block text-sm">开启推广中心</strong>
                                    <span className="text-xs text-foreground/55">关闭后所有人都看不到入口，新注册不再绑定、新充值不再返佣，已发放返佣保留。</span>
                                </span>
                                <Switch aria-label="开启推广中心" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
                            </label>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <span>
                                    <strong className="block text-sm">开放方式</strong>
                                    <span className="text-xs text-foreground/55">{draft.mode === "all" ? "所有正常账号都能看到推广中心、推广链接和推广收益。" : "只有被设为推广人的账号能看到推广中心入口并获得返佣。"}</span>
                                </span>
                                <SegmentedControl<ReferralMode>
                                    ariaLabel="推广开放方式"
                                    size="sm"
                                    value={draft.mode}
                                    options={[
                                        { value: "all", label: "全民推广" },
                                        { value: "assigned", label: "指定推广人" },
                                    ]}
                                    onChange={(mode) => setDraft({ ...draft, mode })}
                                />
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <span>
                                    <strong className="block text-sm">返佣比例</strong>
                                    <span className="text-xs text-foreground/55">0%-50%，修改只影响之后入账的订单。</span>
                                </span>
                                <InputNumber
                                    aria-label="返佣比例"
                                    min={0}
                                    max={50}
                                    step={0.5}
                                    precision={2}
                                    suffix="%"
                                    value={draft.commissionRateBasisPoints / 100}
                                    onChange={(value) => setDraft({ ...draft, commissionRateBasisPoints: Math.round(Number(value ?? 0) * 100) })}
                                />
                            </div>
                        </div>
                    )}
                </SettingsSectionCard>
                <SettingsSectionCard title="返佣记录" description="全站推广返佣明细，按入账时间倒序。" layout="stacked">
                    <AdminDataTable<ReferralCommission>
                        empty={<AdminTableEmpty title="暂无返佣记录" description="被邀请用户完成积分充值后会出现在这里。" />}
                        footer={commissions.data && commissions.data.total > PAGE_SIZE ? <PaginationBar current={page} pageSize={PAGE_SIZE} total={commissions.data.total} pageSizeOptions={[PAGE_SIZE]} onChange={(next) => setPage(next)} /> : undefined}
                        table={{
                            rowKey: "id",
                            loading: commissions.isPending,
                            dataSource: commissions.data?.commissions ?? [],
                            pagination: false,
                            columns: [
                                { key: "inviter", title: "推广人", dataIndex: "inviterName" },
                                { key: "invitee", title: "被邀请用户", dataIndex: "inviteeName" },
                                { key: "amount", title: "充值金额", dataIndex: "orderAmountFen", align: "right", render: (value: number) => <span className="tabular-nums">{formatReferralYuan(value)}</span> },
                                { key: "credits", title: "到账积分", dataIndex: "orderCreditsMicrocredits", align: "right", render: (value: number) => <span className="tabular-nums">{formatReferralCredits(value)}</span> },
                                { key: "rate", title: "比例", dataIndex: "rateBasisPoints", align: "center", render: (value: number) => formatReferralRate(value) },
                                { key: "commission", title: "返佣积分", dataIndex: "commissionMicrocredits", align: "right", render: (value: number) => <span className="tabular-nums">+{formatReferralCredits(value)}</span> },
                                { key: "createdAt", title: "入账时间", dataIndex: "createdAt", align: "center", render: (value: string) => <span className="tabular-nums">{new Date(value).toLocaleString("zh-CN", { hour12: false })}</span> },
                            ],
                        }}
                    />
                </SettingsSectionCard>
            </div>
        </AdminPageFrame>
    );
}
