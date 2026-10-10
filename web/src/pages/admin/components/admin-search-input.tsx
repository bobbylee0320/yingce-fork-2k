import { Input, type InputProps } from "antd";
import { useEffect, useRef, useState } from "react";

// URL-backed filters must not replace the IME's uncommitted composition text.
export function AdminSearchInput({ value = "", onValueChange, ...props }: Omit<InputProps, "value" | "defaultValue" | "onChange" | "onCompositionStart" | "onCompositionEnd"> & { value?: string; onValueChange: (value: string) => void }) {
    const [draft, setDraft] = useState(value);
    const composing = useRef(false);
    useEffect(() => {
        if (!composing.current) setDraft(value);
    }, [value]);

    return (
        <Input
            {...props}
            value={draft}
            onCompositionStart={() => {
                composing.current = true;
            }}
            onCompositionEnd={(event) => {
                composing.current = false;
                const next = event.currentTarget.value;
                setDraft(next);
                onValueChange(next);
            }}
            onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                if (!composing.current) onValueChange(next);
            }}
        />
    );
}
