// 短剧制作模型选择：在创作端通用模型目录（带图标的 ModelPicker）与后端 DramaModelChoice 之间互转。
// 短剧由服务端无人值守执行，只能使用平台模型；个人渠道的密钥在浏览器里，不能进入这里。

import { logicalModelIDForConfig, modelDisplayName, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import type { DramaModelChoice } from "@/services/api/drama";

export function dramaChoiceKey(choice?: DramaModelChoice) {
    if (!choice) return "";
    return choice.logicalModelId ? `l:${choice.logicalModelId}` : choice.channelId ? `c:${choice.channelId}:${choice.modelKey}` : "";
}

/** 通用目录中的模型值转换为后端选择；个人渠道返回 undefined。 */
export function modelToDramaChoice(config: AiConfig, model: string): DramaModelChoice | undefined {
    if (!model) return undefined;
    const label = modelDisplayName(config, model);
    const logicalModelId = logicalModelIDForConfig({ ...config, model });
    if (logicalModelId) return { logicalModelId, label };
    const channel = resolveModelChannel(config, model);
    if (channel.scope !== "system" || !channel.id) return undefined;
    return { channelId: channel.id, modelKey: modelOptionName(model), label };
}

/**
 * 通用目录中一个模型可能对应的全部后端选择键：产品模型 l:，以及它所在平台渠道的 c:。
 * 前后端对同一模型可能用不同口径登记（例如产品模型开关不同步），两种键都参与匹配。
 */
export function dramaChoiceKeys(config: AiConfig, model: string) {
    if (!model) return [];
    const keys: string[] = [];
    const logicalModelId = logicalModelIDForConfig({ ...config, model });
    if (logicalModelId) keys.push(`l:${logicalModelId}`);
    const channel = resolveModelChannel(config, model);
    if (channel.scope === "system" && channel.id) keys.push(`c:${channel.id}:${modelOptionName(model)}`);
    return keys;
}

/** 后端选择在通用目录中的模型值；目录尚未加载或模型已下架时返回空串。 */
export function dramaChoiceToModel(config: AiConfig, capability: ModelCapability, choice?: DramaModelChoice) {
    const key = dramaChoiceKey(choice);
    if (!key) return "";
    return selectableModelsByCapability(config, capability).find((model) => dramaChoiceKeys(config, model).includes(key)) || "";
}
