import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { BookMarked, FileText, Search, X } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal";
import type { DramaSkillRef } from "@/services/api/drama";
import { getSkillFile, listAddedSkills, listSkillFiles } from "@/services/api/skills";

/**
 * 剧情段视频提示词的写作技能：选一个已添加技能里的文本文件，撰写时把全文交给文本模型作为写作方法。
 * 保存的是技能与文件引用，技能更新后下一次撰写会读到新内容。
 */
export function PromptSkillField({ value, onChange }: { value?: DramaSkillRef; onChange: (value?: DramaSkillRef) => void }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="drama-pskill">
            {value ? (
                <div className="drama-pskill-current">
                    <BookMarked className="size-4 shrink-0 text-[var(--workspace-accent)]" aria-hidden />
                    <div className="min-w-0">
                        <strong>{value.skillName || value.skillId}</strong>
                        <span title={value.path}>{value.path}</span>
                    </div>
                    <Button size="small" onClick={() => setOpen(true)}>
                        更换
                    </Button>
                    <Button size="small" type="text" icon={<X className="size-3.5" />} aria-label="不使用技能" onClick={() => onChange(undefined)} />
                </div>
            ) : (
                <div className="drama-pskill-current is-empty">
                    <span>未选择技能，按内置格式撰写（视觉与首帧、站位轴线、角色道具、光源声音、逐镜时间码）。</span>
                    <Button size="small" icon={<BookMarked className="size-3.5" />} onClick={() => setOpen(true)}>
                        选择技能
                    </Button>
                </div>
            )}
            <PromptSkillModal
                open={open}
                initial={value}
                onClose={() => setOpen(false)}
                onPick={(ref) => {
                    onChange(ref);
                    setOpen(false);
                }}
            />
        </div>
    );
}

function PromptSkillModal({ open, initial, onClose, onPick }: { open: boolean; initial?: DramaSkillRef; onClose: () => void; onPick: (value: DramaSkillRef) => void }) {
    const [keyword, setKeyword] = useState("");
    const [skillId, setSkillId] = useState(initial?.skillId || "");
    const [path, setPath] = useState(initial?.path || "");
    useEffect(() => {
        if (!open) return;
        setSkillId(initial?.skillId || "");
        setPath(initial?.path || "");
    }, [initial, open]);
    const skillsQuery = useQuery({ queryKey: ["skills", "added"], queryFn: listAddedSkills, enabled: open, staleTime: 30_000 });
    const skills = useMemo(() => (skillsQuery.data?.skills || []).filter((skill) => !keyword.trim() || `${skill.skillName} ${skill.description}`.toLowerCase().includes(keyword.trim().toLowerCase())), [keyword, skillsQuery.data]);
    const skill = skillsQuery.data?.skills.find((item) => item.skillId === skillId);
    const filesQuery = useQuery({ queryKey: ["skills", skillId, "files"], queryFn: () => listSkillFiles(skillId), enabled: open && Boolean(skillId), staleTime: 60_000 });
    const files = (filesQuery.data?.files || []).filter((file) => file.kind === "markdown" || file.kind === "text");
    // 选中技能后默认定位到 SKILL.md，这是技能的主说明。
    useEffect(() => {
        if (!skillId || path || !files.length) return;
        setPath((files.find((file) => file.path.toLowerCase() === "skill.md") || files[0]).path);
    }, [files, path, skillId]);
    const fileQuery = useQuery({ queryKey: ["skills", skillId, "file", path], queryFn: () => getSkillFile(skillId, path), enabled: open && Boolean(skillId && path), staleTime: 60_000 });
    const content = fileQuery.data?.file.content || "";
    return (
        <AppModal open={open} onCancel={onClose} footer={null} width={1080} flush title={null} centered>
            <div className="drama-skill-import">
                <header className="drama-skill-import-head">
                    <div>
                        <strong>选择视频提示词技能</strong>
                        <span>撰写每个剧情段的视频提示词时，会把所选文件全文交给文本模型，按其中的结构和写法输出。</span>
                    </div>
                </header>
                <div className="drama-skill-import-body">
                    <aside>
                        <Input size="small" prefix={<Search className="size-3.5" />} allowClear placeholder="搜索已添加的技能" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                        <div className="drama-skill-import-list thin-scrollbar">
                            {skills.map((item) => (
                                <button
                                    key={item.skillId}
                                    type="button"
                                    aria-pressed={item.skillId === skillId}
                                    onClick={() => {
                                        setSkillId(item.skillId);
                                        setPath("");
                                    }}
                                >
                                    <strong>{item.skillName}</strong>
                                    <span>{item.description || "—"}</span>
                                </button>
                            ))}
                            {!skillsQuery.isLoading && !skills.length ? <div className="drama-skill-import-empty">还没有添加技能，可在「技能」页面添加后再选择。</div> : null}
                        </div>
                    </aside>
                    <aside>
                        <div className="drama-skill-import-caption">{skill ? `${skill.skillName} · ${files.length} 份文本` : "文件"}</div>
                        <div className="drama-skill-import-list thin-scrollbar">
                            {files.map((file) => (
                                <button key={file.path} type="button" className="is-file" aria-pressed={file.path === path} onClick={() => setPath(file.path)}>
                                    <FileText className="size-3.5 shrink-0" />
                                    <span title={file.path}>{file.path}</span>
                                </button>
                            ))}
                            {skillId && !filesQuery.isLoading && !files.length ? <div className="drama-skill-import-empty">这个技能没有文本文件。</div> : null}
                            {!skillId ? <div className="drama-skill-import-empty">先在左侧选择技能</div> : null}
                        </div>
                    </aside>
                    <section>
                        <div className="drama-skill-import-caption">
                            {path || "原文"}
                            {content ? (
                                <span>
                                    {content.length.toLocaleString("zh-CN")} 字{content.length > 16000 ? " · 超过 16000 字的部分不会发送" : ""}
                                </span>
                            ) : null}
                        </div>
                        <pre className="drama-skill-import-content thin-scrollbar">{fileQuery.isLoading ? "正在读取…" : content || "选择文件后在这里查看全文。"}</pre>
                    </section>
                </div>
                <footer className="drama-skill-import-foot">
                    <span>修改后对之后撰写的剧情段生效；已写好的段可在分镜页多选后“重新撰写提示词”。</span>
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" disabled={!skill || !path || !content} onClick={() => skill && onPick({ skillId: skill.skillId, skillName: skill.skillName, path })}>
                        使用这个文件
                    </Button>
                </footer>
            </div>
        </AppModal>
    );
}
