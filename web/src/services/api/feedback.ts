import { compactApiParams, http, serializeApiParams } from "./request";

export type FeedbackType = "bug" | "feature" | "improvement" | "other";
export type FeedbackStatus = "pending" | "processing" | "resolved" | "closed";

export interface FeedbackAttachment {
    id: string;
    name: string;
    type: "image" | "video";
    url: string;
    size: number;
    mimeType?: string;
}

export interface FeedbackItem {
    id: string;
    userId: string;
    userName: string;
    userEmail?: string;
    contact?: string;
    type: FeedbackType;
    title: string;
    content: string;
    attachments?: string; // JSON encoded FeedbackAttachment[]
    environment?: string; // JSON encoded client info
    status: FeedbackStatus;
    adminReply?: string;
    repliedAt?: string;
    archived?: boolean;
    archivedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface SubmitFeedbackPayload {
    type: FeedbackType;
    title: string;
    content: string;
    contact?: string;
    attachments?: string;
    environment?: string;
}

export interface FeedbackListResult {
    list: FeedbackItem[];
    total: number;
    page: number;
    limit: number;
}

export interface AdminFeedbackFilter {
    type?: string;
    status?: string;
    keyword?: string;
    archived?: boolean | "all";
    page?: number;
    limit?: number;
}

export async function submitFeedback(payload: SubmitFeedbackPayload): Promise<FeedbackItem> {
    return http.post<FeedbackItem>("/feedbacks", payload);
}

export async function getMyFeedbacks(): Promise<FeedbackItem[]> {
    return http.get<FeedbackItem[]>("/feedbacks/my");
}

export async function uploadFeedbackAttachment(file: File): Promise<FeedbackAttachment> {
    const formData = new FormData();
    formData.append("file", file);
    return http.post<FeedbackAttachment>("/feedbacks/attachments", formData);
}

export async function getAdminFeedbacks(filter: AdminFeedbackFilter = {}): Promise<FeedbackListResult> {
    const params = compactApiParams({
        type: filter.type && filter.type !== "all" ? filter.type : undefined,
        status: filter.status && filter.status !== "all" ? filter.status : undefined,
        archived: filter.archived !== undefined && filter.archived !== "all" ? String(filter.archived) : undefined,
        keyword: filter.keyword,
        page: filter.page || undefined,
        pageSize: filter.limit || undefined,
    });
    const queryStr = serializeApiParams(params).toString();
    const url = queryStr ? `/admin/feedbacks?${queryStr}` : "/admin/feedbacks";
    return http.get<FeedbackListResult>(url);
}

export async function updateAdminFeedback(id: string, payload: { status?: FeedbackStatus; adminReply?: string; archived?: boolean }): Promise<FeedbackItem> {
    return http.patch<FeedbackItem>(`/admin/feedbacks/${id}`, payload);
}

export async function archiveAdminFeedback(id: string, archive = true): Promise<FeedbackItem> {
    const action = archive ? "archive" : "unarchive";
    return http.post<FeedbackItem>(`/admin/feedbacks/${id}/${action}`);
}

export async function deleteAdminFeedback(id: string): Promise<{ ok: boolean }> {
    return http.delete<{ ok: boolean }>(`/admin/feedbacks/${id}`);
}
