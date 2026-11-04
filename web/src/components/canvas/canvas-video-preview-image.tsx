import type { ImgHTMLAttributes, ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { canvasNodeVideoPreviewReference } from "@/lib/canvas/canvas-media-preview";
import type { CanvasNodeData } from "@/types/canvas";

type CanvasVideoPreviewImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    node: CanvasNodeData;
    fallback?: ReactNode;
    expiredFallback?: ReactNode;
    loadingFallback?: ReactNode;
    eager?: boolean;
};

/**
 * Passive video poster image. Persisted posters are always resolved through
 * their resource storage key so remote media is served by OSS/CDN rather than
 * an obsolete platform proxy URL embedded in older canvas snapshots.
 */
export function CanvasVideoPreviewImage({ node, fallback = null, expiredFallback = fallback, loadingFallback = fallback, eager = false, ...props }: CanvasVideoPreviewImageProps) {
    const preview = canvasNodeVideoPreviewReference(node);
    if (!preview) return <>{fallback}</>;
    return (
        <CachedResourceImage
            {...props}
            storageKey={preview.storageKey}
            src={preview.src}
            fallback={fallback}
            expiredFallback={expiredFallback}
            loadingFallback={loadingFallback}
            eager={eager}
        />
    );
}
