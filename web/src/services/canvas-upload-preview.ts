// 上传中节点的本地预览地址只保存在当前页面内存里。
// 不写入节点 metadata：blob: 地址一旦进入画布数据会被同步到服务端，刷新或换设备后即失效。
const previews = new Map<string, string>();

export function registerUploadPreview(nodeId: string, file: Blob) {
    releaseUploadPreview(nodeId);
    const url = URL.createObjectURL(file);
    previews.set(nodeId, url);
    return url;
}

export function uploadPreviewUrl(nodeId: string) {
    return previews.get(nodeId) || "";
}

export function releaseUploadPreview(nodeId: string) {
    const url = previews.get(nodeId);
    if (!url) return;
    previews.delete(nodeId);
    URL.revokeObjectURL(url);
}
