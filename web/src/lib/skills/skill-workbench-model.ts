// 技能工作台的纯函数：工作副本 → 文件树、路径校验（与后端 normalizeSkillEditPath 对齐）、
// 以及把本地修改折叠成 PUT /skills/:id/files 的有序批量操作。

export const SKILL_ENTRY_PATH = "SKILL.md";
export const SKILL_TEXT_LIMIT_BYTES = 512 * 1024;
export const SKILL_MAX_PATH_DEPTH = 8;
export const SKILL_MAX_FILES = 512;

export type SkillFileOperation = { op: "write"; path: string; content: string } | { op: "rename"; path: string; to: string } | { op: "delete"; path: string };

/** 工作副本中的一个文件；origin 是它在基线版本里的路径，新建文件为 null。 */
export type WorkbenchEntry = { path: string; origin: string | null };

export type TreeFolderNode = { type: "folder"; path: string; name: string; children: TreeNode[] };
export type TreeFileNode = { type: "file"; path: string; name: string };
export type TreeNode = TreeFolderNode | TreeFileNode;

export type TreeRow = { type: "folder" | "file"; path: string; name: string; depth: number; parent: string; expanded: boolean };

const binaryExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "bmp",
    "ico",
    "avif",
    "mp4",
    "webm",
    "mov",
    "mkv",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "flac",
    "zip",
    "gz",
    "tar",
    "rar",
    "7z",
    "pdf",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "wasm",
]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function fileExtension(filePath: string) {
    const name = baseName(filePath);
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function baseName(filePath: string) {
    const index = filePath.lastIndexOf("/");
    return index >= 0 ? filePath.slice(index + 1) : filePath;
}

export function parentPath(filePath: string) {
    const index = filePath.lastIndexOf("/");
    return index >= 0 ? filePath.slice(0, index) : "";
}

export function joinPath(parent: string, name: string) {
    return parent ? `${parent}/${name}` : name;
}

export function isImagePath(filePath: string) {
    return imageExtensions.has(fileExtension(filePath));
}

export function isMarkdownPath(filePath: string) {
    const extension = fileExtension(filePath);
    return extension === "md" || extension === "mdx" || extension === "markdown";
}

/** 新建文件只允许文本类型；二进制资源请通过 ZIP 安装。 */
export function isTextEditablePath(filePath: string) {
    return !binaryExtensions.has(fileExtension(filePath));
}

export function utf8ByteLength(value: string) {
    return new TextEncoder().encode(value).length;
}

const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/;

/** 返回错误文案；合法时返回 null。规则与后端保持一致，提交前尽早拦截。 */
export function validateSkillPath(filePath: string): string | null {
    if (!filePath) return "名称不能为空";
    if (filePath.includes("\\")) return "路径不能包含反斜杠";
    if (filePath.startsWith("/")) return "请使用相对路径";
    const segments = filePath.split("/");
    if (segments.length > SKILL_MAX_PATH_DEPTH) return `目录层级不能超过 ${SKILL_MAX_PATH_DEPTH} 层`;
    for (const segment of segments) {
        if (!segment) return "路径不能包含空的层级";
        if (segment === "." || segment === "..") return "路径不能包含 . 或 ..";
        if (segment.trim() !== segment) return "名称不能以空格开头或结尾";
        if (controlCharacter.test(segment)) return "名称不能包含控制字符";
        if (utf8ByteLength(segment) > 255) return "名称过长";
    }
    if (segments[0] === ".git" || segments[0] === "__MACOSX") return "不能使用系统保留目录";
    if (segments[segments.length - 1] === ".DS_Store") return "不能使用系统保留文件名";
    return null;
}

export function isDescendantPath(filePath: string, folder: string) {
    return folder === "" || filePath.startsWith(`${folder}/`);
}

/** 所有文件的祖先目录 + 本地显式创建的空目录。 */
export function collectFolders(paths: Iterable<string>, explicitFolders: Iterable<string> = []) {
    const folders = new Set<string>();
    const add = (filePath: string) => {
        for (let dir = parentPath(filePath); dir; dir = parentPath(dir)) folders.add(dir);
    };
    for (const filePath of paths) add(filePath);
    for (const folder of explicitFolders) {
        folders.add(folder);
        add(folder);
    }
    return folders;
}

/** 新路径不能与已有文件或文件夹重名，也不能把文件当作文件夹使用。 */
export function pathConflict(target: string, filePaths: Set<string>, folders: Set<string>, ignore?: (filePath: string) => boolean): string | null {
    if ((filePaths.has(target) && !ignore?.(target)) || folders.has(target)) return "同名文件或文件夹已存在";
    for (let dir = parentPath(target); dir; dir = parentPath(dir)) {
        if (filePaths.has(dir) && !ignore?.(dir)) return `“${dir}” 是文件，不能作为文件夹`;
    }
    return null;
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function buildFileTree(paths: Iterable<string>, explicitFolders: Iterable<string> = []): TreeNode[] {
    const root: TreeFolderNode = { type: "folder", path: "", name: "", children: [] };
    const folders = new Map<string, TreeFolderNode>([["", root]]);
    const ensureFolder = (folderPath: string): TreeFolderNode => {
        const existing = folders.get(folderPath);
        if (existing) return existing;
        const parent = ensureFolder(parentPath(folderPath));
        const node: TreeFolderNode = { type: "folder", path: folderPath, name: baseName(folderPath), children: [] };
        parent.children.push(node);
        folders.set(folderPath, node);
        return node;
    };
    for (const folder of explicitFolders) ensureFolder(folder);
    for (const filePath of paths) ensureFolder(parentPath(filePath)).children.push({ type: "file", path: filePath, name: baseName(filePath) });
    const sort = (nodes: TreeNode[]) => {
        nodes.sort((left, right) => {
            if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
            // 入口文件始终置顶，和技能详情保持一致。
            if (left.path === SKILL_ENTRY_PATH) return -1;
            if (right.path === SKILL_ENTRY_PATH) return 1;
            return collator.compare(left.name, right.name);
        });
        for (const node of nodes) if (node.type === "folder") sort(node.children);
    };
    sort(root.children);
    return root.children;
}

/**
 * 把树按当前展开状态拍平成可键盘导航的行。
 * 有筛选词时只保留匹配文件及其祖先目录，并强制展开命中路径。
 */
export function flattenTree(nodes: TreeNode[], expanded: Set<string>, filter = ""): TreeRow[] {
    const needle = filter.trim().toLowerCase();
    const rows: TreeRow[] = [];
    const matches = (node: TreeNode): boolean => (node.type === "file" ? node.path.toLowerCase().includes(needle) : node.children.some(matches) || (node.path.toLowerCase().includes(needle) && node.children.length === 0));
    const walk = (items: TreeNode[], depth: number, parent: string) => {
        for (const node of items) {
            if (needle && !matches(node)) continue;
            const isExpanded = node.type === "folder" && (needle ? true : expanded.has(node.path));
            rows.push({ type: node.type, path: node.path, name: node.name, depth, parent, expanded: isExpanded });
            if (node.type === "folder" && isExpanded) walk(node.children, depth + 1, node.path);
        }
    };
    walk(nodes, 0, "");
    return rows;
}

/** 在基线版本路径上模拟改名，生成不会互相覆盖的有序 rename（环形交换借助临时名）。 */
function orderRenames(renames: Array<{ from: string; to: string }>, occupied: Set<string>): SkillFileOperation[] {
    const operations: SkillFileOperation[] = [];
    const pending = renames.filter((item) => item.from !== item.to).map((item) => ({ ...item }));
    let temporaryIndex = 0;
    while (pending.length) {
        const index = pending.findIndex((item) => !occupied.has(item.to));
        if (index >= 0) {
            const [item] = pending.splice(index, 1);
            operations.push({ op: "rename", path: item.from, to: item.to });
            occupied.delete(item.from);
            occupied.add(item.to);
            continue;
        }
        const item = pending[0];
        let temporary = "";
        do {
            temporary = `__yingce_rename_${temporaryIndex++}__${fileExtension(item.from) ? `.${fileExtension(item.from)}` : ""}`;
        } while (occupied.has(temporary));
        operations.push({ op: "rename", path: item.from, to: temporary });
        occupied.delete(item.from);
        occupied.add(temporary);
        item.from = temporary;
    }
    return operations;
}

/**
 * 把工作副本与基线差异折叠为有序批量操作：先删除，再改名，最后写入内容。
 * contents 只需要包含已打开/编辑过的文件；新建且从未打开的文件按空文本写入。
 */
export function buildSaveOperations(input: { basePaths: Iterable<string>; entries: WorkbenchEntry[]; buffers: Map<string, string>; baseContents: Map<string, string> }): SkillFileOperation[] {
    const basePaths = new Set(input.basePaths);
    const keptOrigins = new Set(input.entries.flatMap((entry) => (entry.origin ? [entry.origin] : [])));
    const deletes: SkillFileOperation[] = [...basePaths]
        .filter((filePath) => !keptOrigins.has(filePath))
        .sort()
        .map((filePath) => ({ op: "delete", path: filePath }));
    const occupied = new Set([...basePaths].filter((filePath) => keptOrigins.has(filePath)));
    const renames = orderRenames(
        input.entries.flatMap((entry) => (entry.origin && entry.origin !== entry.path ? [{ from: entry.origin, to: entry.path }] : [])),
        occupied,
    );
    const writes: SkillFileOperation[] = [];
    for (const entry of input.entries) {
        const buffer = input.buffers.get(entry.path);
        if (!entry.origin) {
            writes.push({ op: "write", path: entry.path, content: buffer ?? "" });
            continue;
        }
        if (buffer !== undefined && buffer !== input.baseContents.get(entry.origin)) writes.push({ op: "write", path: entry.path, content: buffer });
    }
    return [...deletes, ...renames, ...writes];
}

export function isEntryDirty(entry: WorkbenchEntry, buffers: Map<string, string>, baseContents: Map<string, string>) {
    if (!entry.origin || entry.origin !== entry.path) return true;
    const buffer = buffers.get(entry.path);
    return buffer !== undefined && buffer !== baseContents.get(entry.origin);
}

/** 简单子序列模糊匹配：命中越集中、越靠近文件名得分越高；未命中返回 -1。 */
export function fuzzyScore(filePath: string, query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle) return 0;
    const haystack = filePath.toLowerCase();
    const nameStart = haystack.lastIndexOf("/") + 1;
    let score = 0;
    let cursor = 0;
    let previous = -2;
    for (const char of needle) {
        const found = haystack.indexOf(char, cursor);
        if (found < 0) return -1;
        score += found === previous + 1 ? 3 : 1;
        if (found >= nameStart) score += 1;
        previous = found;
        cursor = found + 1;
    }
    if (haystack.slice(nameStart).includes(needle)) score += 10;
    return score - haystack.length * 0.01;
}

export function formatSkillBytes(value: number) {
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function languageLabel(filePath: string) {
    const extension = fileExtension(filePath);
    const labels: Record<string, string> = {
        md: "Markdown",
        mdx: "MDX",
        markdown: "Markdown",
        json: "JSON",
        yaml: "YAML",
        yml: "YAML",
        toml: "TOML",
        py: "Python",
        js: "JavaScript",
        jsx: "JavaScript",
        ts: "TypeScript",
        tsx: "TypeScript",
        sh: "Shell",
        go: "Go",
        html: "HTML",
        css: "CSS",
        txt: "纯文本",
        csv: "CSV",
    };
    return labels[extension] || "纯文本";
}
