import { useEffect, useState } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import { resolveMediaUrl } from "@/services/file-storage";

export function AudioReferencePreview({ name, src = "", storageKey, onClose }: { name: string; src?: string; storageKey?: string; onClose: () => void }) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        setUrl("");
        setError("");
        void resolveMediaUrl(storageKey, src, "playback")
            .then((resolved) => {
                if (cancelled) return;
                if (resolved) setUrl(resolved);
                else setError("音频暂不可用，请重新上传后试听");
            })
            .catch(() => {
                if (!cancelled) setError("音频加载失败，请关闭后重试");
            });
        return () => {
            cancelled = true;
        };
    }, [src, storageKey]);

    return (
        <AppModal open title={name || "音频试听"} footer={null} centered onCancel={onClose}>
            {error ? (
                <p role="alert">{error}</p>
            ) : url ? (
                <audio key={url} src={url} controls autoPlay preload="metadata" className="w-full" aria-label={`播放 ${name}`} onError={() => setError("音频播放失败，请检查文件格式或重新上传")} />
            ) : (
                <p role="status">正在加载音频…</p>
            )}
        </AppModal>
    );
}
