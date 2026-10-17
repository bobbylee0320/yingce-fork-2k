// 目录手写 ID 与品牌组件的大小写可能不同；统一解析但不改写已有渠道配置。
export function createModelLogoResolver(ids: string[]) {
    const canonical = new Map(ids.map((id) => [id.toLowerCase(), id]));
    return (value?: string): string | undefined => {
        const id = value?.trim();
        return id ? canonical.get(id.toLowerCase()) : undefined;
    };
}
