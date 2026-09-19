import process from "node:process";
import { createInterface } from "node:readline/promises";
import { getDefaultCredentialPath, loadCredentials } from "../auth.js";
import { DeepSeekWebClient } from "../deepseekWebClient.js";
import { parseResultFromStream } from "../deepseekStreamParser.js";
import { isDirectRun } from "../utils.js";
import { parseArgs } from "node:util";

interface ChatResult {
    text: string;
    thinking: string;
    messageId: number | null;
    sessionId: string;
}

async function chatWithDeepSeek(
    client: DeepSeekWebClient,
    params: {
        message: string;
        sessionId?: string;
        parentMessageId?: number | null;
        signal?: AbortSignal;
        onDelta?: (type: string, delta: string) => void,
    }): Promise<ChatResult> {
    params.signal?.throwIfAborted();
    const session = params.sessionId ?? await client.createChatSession();
    const body = await client.chatCompletions({
        sessionId: session,
        message: params.message,
        modelType: "default",
        searchEnabled: true,
        thinkingEnabled: false,
        parentMessageId: params.parentMessageId ?? null,
        signal: params.signal,
    });
    const result = await parseResultFromStream(body, params.onDelta, {
        signal: params.signal,
        continueChat: messageId => client.continueChat({ sessionId: session, messageId, signal: params.signal }),
        stopChat: messageId => client.stopChat({ sessionId: session, messageId }),
    });
    return { ...result, sessionId: session };
}

async function runChatCli() {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            credentials: { type: "string", short: "c" },
            interactive: { type: "boolean", short: "i" },
            delete: { type: "boolean", short: "d" },
        },
        allowPositionals: true,
        strict: true,
    });

    const interactive = parsed.values.interactive;
    let message = parsed.positionals.join(" ").trim();
    if (!interactive && !message) throw new Error("Missing chat message.");
    const credentials = loadCredentials(parsed.values.credentials ?? getDefaultCredentialPath());
    const client = new DeepSeekWebClient({
        cookie: credentials.cookie,
        bearer: credentials.bearer,
        userAgent: credentials.userAgent,
    });
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let sessionId: string | undefined;
    let parentMessageId: number | null = null;
    // Ctrl+C 只取消任务，等待停止和读流清理完成后再退出
    const onInterrupt = () => controller.abort();
    process.on("SIGINT", onInterrupt);
    rl?.on("SIGINT", onInterrupt);
    if (interactive) process.stdout.write("Interactive chat mode. Press Ctrl+C to exit.\n");
    try {
        while (!signal.aborted) {
            if (!message && rl) message = (await rl.question("you> ", { signal })).trim();
            if (!message) continue;
            // 提前保存会话 ID，首轮取消后也能按需删除会话
            signal.throwIfAborted();
            sessionId ??= await client.createChatSession();
            let state: string | null = null;
            const result = await chatWithDeepSeek(client, {
                message, sessionId, parentMessageId, signal,
                onDelta: (type, delta) => {
                    if (state !== null && type !== state) process.stdout.write(interactive ? "\n" : "\n---------\n");
                    state = type;
                    if (type === "THINK") process.stdout.write(`\x1b[90m${delta}\x1b[0m`);
                    else if (!interactive || type === "RESPONSE") process.stdout.write(delta);
                },
            });
            if (!result.text.endsWith("\n")) process.stdout.write("\n");
            if (!interactive) break;
            parentMessageId = result.messageId;
            message = "";
        }
    } catch (error) {
        if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
    } finally {
        rl?.off("SIGINT", onInterrupt);
        rl?.close();
        try {
            if (parsed.values.delete && sessionId) {
                await client.deleteSession(sessionId);
                if (interactive) process.stdout.write("Deleted chat session.\n");
            }
        } finally {
            process.off("SIGINT", onInterrupt);
        }
    }
    if (signal.aborted) process.stdout.write("\nExited chat.\n");
}


if (isDirectRun(import.meta.url)) {
    console.log("Starting DeepSeek chat...");
    runChatCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}

