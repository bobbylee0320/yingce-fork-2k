import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

type SafeImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
    src?: string;
    /** 地址为空或加载失败时显示的内容；不传时什么都不渲染，避免出现浏览器默认的破图和溢出的 alt 文字。 */
    fallback?: ReactNode;
};

// 用途：展示管理员配置或外部来源的图片（工具图标、封面、外部素材缩略图）。地址失效时回退到 fallback。
export function SafeImage({ src, fallback = null, ...props }: SafeImageProps) {
    const [failedSrc, setFailedSrc] = useState<string>();
    if (!src || failedSrc === src) return <>{fallback}</>;
    return <img {...props} src={src} onError={() => setFailedSrc(src)} />;
}
