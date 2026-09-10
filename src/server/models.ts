import type { ServerChatRequest } from "../deepseekWebClient.js";

export const DEFAULT_MODEL = "deepseek";
export const MODEL_LIST = [
    "deepseek",
    "deepseek-thinking",
    "deepseek-thinking-nosearch",
    "deepseek-nosearch",
];

export function getModelConfig(model: string = DEFAULT_MODEL) {
    if (!MODEL_LIST.includes(model)) {
        throw new Error(`Unsupported model: ${model}`);
    }
    const modelType: ServerChatRequest["modelType"] = "default";
    return {
        model,
        modelType,
        thinkingEnabled: model.includes("thinking"),
        searchEnabled: !model.includes("nosearch"),
    };
}