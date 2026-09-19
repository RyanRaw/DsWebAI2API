import { SseStreamParser, type SSEvent } from "./sseStreamParser.js";
type DeltaFn = (type: string, delta: string) => void;

export class DeepSeekStreamError extends Error {
    constructor(content: string, public readonly messageId: number | null) {
        super(`Deepseek API Error: ${content}`);
        this.name = "DeepSeekStreamError";
    }
}

/**
 * DeepseekStateDecoder 负责根据 SSE 事件构建一个状态对象，支持基于路径的增量更新和批量操作
 */
export class DeepseekStateDecoder {
    static NUM_RE = /^-?\d+$/;
    state: {
        ready: Record<string, any> | null;
        hint: Record<string, any> | null;
        toast: Record<string, any> | null;
        update_session: Record<string, any>[];
        message: Record<string, any>;
        title: string | null;
        close: Record<string, any> | null;
        [key: string]: any; // 可能还有没有发现的字段
    };
    private currentPath: string;
    private currentOp: string;
    onDelta?: DeltaFn;  // 在增量更新时的回调，参数为增量类型和增量内容

    constructor(onDelta?: DeltaFn) {
        this.state = {
            ready: null,
            title: null,
            close: null,
            update_session: [],
            message: {},
            hint: null,
            toast: null,
        };
        this.currentPath = 'message';
        this.currentOp = 'SET';
        this.onDelta = onDelta;
    }

    isIntegerToken(token: string) {
        return DeepseekStateDecoder.NUM_RE.test(token);
    }

    /**
     * 根据 message 时获取的 p，构建从 meta 开始的路由路径
     * @returns 统一路由
     */
    normalizePath(path?: string): string {
        if (!path || typeof path !== 'string') return 'message';
        if (path.startsWith('message')) return path;
        return `message/${path}`;
    }

    resolveIndexForRead(arr: Array<any>, token: string): number | null {
        let idx = Number(token);
        if (!Number.isInteger(idx)) return null;
        if (idx < 0) idx = arr.length + idx;
        if (idx < 0 || idx >= arr.length) return null;
        return idx;
    }

    /**
     * 得到索引
     * @param {Array} arr 
     * @param {string} token 疑似索引
     * @returns {number | null} 合法索引或null
     */
    resolveIndexForWrite(arr: Array<any>, token: string): number | null {
        let idx = Number(token);
        if (!Number.isInteger(idx)) return null;    // 说明不是数字
        if (idx < 0) idx += arr.length;
        if (idx < 0) return 0;
        return idx;
    }

    /**
     * 索引到倒数第二层，返回这一层的容器，如果缺少则创建
     * @returns 容器对象或null 后者表示路径不合法
     */
    ensureContainer(root: Record<PropertyKey, any>, pathTokens: string[]): Record<PropertyKey, any> | null {
        let node = root;
        for (let i = 0; i < pathTokens.length - 1; i += 1) {
            const token = pathTokens[i];
            const next = pathTokens[i + 1];
            const nextShouldBeArray = this.isIntegerToken(next);

            if (Array.isArray(node)) {
                // if (!isIntegerToken(token)) return null;
                const idx = this.resolveIndexForWrite(node, token);
                if (idx === null) return null;  // 索引不合法
                if (node[idx] === undefined || node[idx] === null || typeof node[idx] !== 'object') {
                    node[idx] = nextShouldBeArray ? [] : {};
                } node = node[idx];
                continue;
            } else {
                if (node[token] === undefined || node[token] === null || typeof node[token] !== 'object') {
                    node[token] = nextShouldBeArray ? [] : {};
                } node = node[token];
            }
        }
        return node;
    }

    getAtPath(root: Record<PropertyKey, any>, pathTokens: string[]): any {
        let node = root;
        for (const token of pathTokens) {
            if (node === null || node === undefined) return undefined;
            if (Array.isArray(node)) {
                const idx = this.resolveIndexForRead(node, token);
                if (idx === null) return undefined;
                node = node[idx];
            } else {
                node = node[token];
            }
        }
        return node;
    }

    // "o":"SET" 直接设置
    setAtPath(root: Record<PropertyKey, any>, pathTokens: string[], value: any) {
        if (pathTokens.length === 0) return;
        const parent = this.ensureContainer(root, pathTokens);
        if (!parent) return;

        const last = pathTokens[pathTokens.length - 1];
        if (Array.isArray(parent)) {
            const idx = this.resolveIndexForWrite(parent, last);
            if (idx === null) return;
            parent[idx] = value;
            return;
        }

        parent[last] = value;
    }

    // "o":"APPEND" 在原有基础上追加
    appendAtPath(root: Record<PropertyKey, any>, pathTokens: string[], value: any) {
        const prev = this.getAtPath(root, pathTokens);
        // 可追加的只有字符串和数组
        if (typeof value === 'string') {
            const base = typeof prev === 'string' ? prev : '';
            this.setAtPath(root, pathTokens, base + value);
            return;
        }
        if (Array.isArray(value)) {
            if (Array.isArray(prev)) {
                prev.push(...value);
            } else {
                this.setAtPath(root, pathTokens, value);
            }
            return;
        }
        // 其他类型直接覆盖
        this.setAtPath(root, pathTokens, value);
    }

    applyOperation(path: string, op: string, value: any) {
        const normalized = this.normalizePath(path);
        const tokens = normalized.split('/').filter(Boolean);

        if (op === 'BATCH') {
            if (!Array.isArray(value)) return;
            for (const patch of value) {
                if (!patch || typeof patch !== 'object') continue;
                const childPath = patch.p ? `${normalized}/${patch.p}` : normalized;
                const childOp = patch.o || 'SET';
                this.applyOperation(childPath, childOp, patch.v);
            }
            return;
        }

        this.collectDelta(tokens, value);

        if (op === 'APPEND') {
            this.appendAtPath(this.state, tokens, value);
            return;
        }

        this.setAtPath(this.state, tokens, value);
    }

    push(item: SSEvent) {
        const { event, data } = item;
        if (!data || typeof data !== 'object') return;
        switch (event) {
            case 'ready':
                this.state.ready = data;
                return;
            case 'update_session':
                this.state.update_session.push(data);
                return;
            case 'title':
                this.state.title = data.content || null;
                return;
            case 'close':
                this.state.close = data;
                return;
            case 'message':
                if (typeof data.p === 'string' && data.p.length) {
                    this.currentPath = this.normalizePath(data.p);
                }
                if (typeof data.o === 'string' && data.o.length) {
                    this.currentOp = data.o;
                }
                this.applyOperation(this.currentPath, this.currentOp, data.v);
                return;
            case 'hint':
                this.state.hint = data;
                return;
            default:
                this.state[event] = data;
        }
    }

    // 增量式
    private emitDelta(type: string | null, delta: string) {
        if (type === null) return;
        if (!delta?.length) return;
        this.onDelta?.(type.toLocaleUpperCase(), delta);
    }
    private emitDeltasFromFragments(fragments: any) {
        if (!Array.isArray(fragments)) return;
        for (const fragment of fragments) {
            if (!fragment || typeof fragment !== 'object') continue;
            this.emitDelta(fragment.type, fragment.content);
        }
    }
    private collectDelta(pathTokens: string[], value: any) {
        if (this.onDelta === null) return;
        const last = pathTokens[pathTokens.length - 1];
        // 第一个message事件
        if (pathTokens.length === 1 && pathTokens[0] === 'message') {
            this.emitDeltasFromFragments(value?.response?.fragments);
            return;
        }
        // BATCH的情况
        if (last === 'fragments' && Array.isArray(value)) {
            this.emitDeltasFromFragments(value);
            return;
        }
        // APPEND
        if (last === 'content' && typeof value === 'string') {
            const fragment = this.getAtPath(this.state, pathTokens.slice(0, -1));
            this.emitDelta(fragment?.type, value);
        }
    }
}

/**
 * DeepseekStreamParser 将 SseStreamParser 和 DeepseekStateDecoder 结合起来，流式解析为DS数据
 */
export class DeepseekStreamParser extends SseStreamParser {
    decoder: DeepseekStateDecoder;
    onEvent?: (event: SSEvent) => void;  // 每当解析出一个事件时的回调，参数为事件对象
    constructor(onDelta?: DeltaFn, onEvent?: (event: SSEvent) => void) {
        super();
        this.decoder = new DeepseekStateDecoder(onDelta);
        this.onEvent = onEvent;
    }
    push(chunk: string): Array<SSEvent> {
        const events = super.push(chunk);
        for (const event of events) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return events;
    }
    finish(): Array<SSEvent> {
        const tailEvents = super.finish();
        for (const event of tailEvents) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return tailEvents;
    }
    parseAll(raw: string): Array<SSEvent> {
        const events = super.parseAll(raw);
        for (const event of events) {
            this.onEvent?.(event);
            this.decoder.push(event);
        } return events;
    }
    text(type: string = "response"): string {
        type = type.toLocaleUpperCase();
        const fragments = this.decoder.state.message?.response?.fragments;
        if (Array.isArray(fragments)) {
            return fragments
                .filter((frag) => frag && frag.type.toLocaleUpperCase() === type && typeof frag.content === 'string')
                .map((frag) => frag.content)
                .join('');
        } return '';
    }
}

export interface StreamReadOptions {
    /** 生成到一半中断了怎么恢复 */
    continueChat?: (messageId: number) => Promise<ReadableStream<Uint8Array>>;
    /** 调用方提供统一的客户端停止方法 */
    stopChat?: (messageId: number) => Promise<void>;
    signal?: AbortSignal;
}

/**
 * 驱动调用方的解析器读流，EOF 后仅对 INCOMPLETE 状态最多续传三次
 * 续传前重建解码状态，按类型跳过已输出的文本前缀，最终保留成功响应的完整状态
 * onEvent 保留原始事件，由调用方决定业务事件的初始化和结束时机
 * 取消或读取异常时，由调用方提供的 stopChat 停止已知消息，等待停止后再释放 reader
 * 内部停止失败仅作为清理失败忽略，保留原来的取消或读取异常
 */
export async function readDeepseekStream(
    stream: ReadableStream<Uint8Array>,
    parser: DeepseekStreamParser,
    { continueChat, stopChat, signal }: StreamReadOptions = {},
) {
    // 暂存调用方回调，每轮读取时包装回调，结束后恢复
    const onDelta = parser.decoder.onDelta;
    const onEvent = parser.onEvent;
    // 跨请求记录各类型已经输出的字符数，续传重放的前缀不再向调用方输出
    const emitted = new Map<string, number>();
    let messageId: number | null = null;
    // 读流或续传请求失败时尽力停止已知消息，清理失败不覆盖原错误
    const stopGeneration = async () => {
        try {
            if (messageId !== null) await stopChat?.(messageId);
        } catch {
            // 停止失败后仍继续本地清理 同时处理 stopChat报错和Promise的reject
        }
    };

    // 首轮读取传入的流，后续每轮读取一次续传响应，失败响应的内容和用量不带入新状态
    for (let retries = 0; ; retries++) {
        if (retries > 0) parser.decoder = new DeepseekStateDecoder(onDelta);
        // received 只统计本轮，按续传重放相同前缀的约定与跨轮累计的 emitted 比较
        const received = new Map<string, number>();
        parser.decoder.onDelta = onDelta && ((type, delta) => {
            if (signal?.aborted) return;
            const start = received.get(type) ?? 0;
            const end = start + delta.length;
            const sent = emitted.get(type) ?? 0;
            received.set(type, end);
            if (end > sent) {
                // 一个 delta 可能同时包含已输出的前缀和新增内容，只保留超出 sent 的部分
                onDelta(type, delta.slice(Math.max(0, sent - start)));
                emitted.set(type, end);
            }
        });
        // onEvent 先于状态解码执行，提前捕获 ID，让事件或增量回调中触发的取消也能停止对应消息
        parser.onEvent = event => {
            if (event.event === 'ready') messageId = toNumberOrNull(event.data?.response_message_id) ?? messageId;
            if (event.event === 'message') messageId = toNumberOrNull(event.data?.v?.response?.message_id) ?? messageId;
            if (!signal?.aborted) onEvent?.(event);
        };
        // 续传响应尚未给出 ID 时沿用上一轮的消息 ID，其余解码状态仍独立
        parser.decoder.state.ready = { response_message_id: messageId };
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let stopping: Promise<void> | undefined;
        // 取消与读取异常共用同一次停止操作，有 ID 时先等待服务端停止，再取消本地读流
        // 尚无 ID 时直接取消本地读流，不等待后续事件补齐 ID
        const stop = (reason?: unknown) => {
            if (stopping) return;
            messageId = toNumberOrNull(parser.decoder.state.message.response?.message_id)
                ?? toNumberOrNull(parser.decoder.state.ready?.response_message_id)
                ?? messageId;
            stopping = stopGeneration().then(() => reader.cancel(reason));
            // 事件监听器无法等待异步结果，先避免未处理的拒绝，错误由 finally 中的 await 传播
            void stopping.catch(() => undefined);
        };
        const onAbort = () => stop(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            // 注册监听前已经取消的信号不会再次派发 abort，需要主动触发清理
            if (signal?.aborted) onAbort();
            // 错误事件和 close 事件都不提前结束读取，读到 EOF 才能保留尾部状态并决定是否续传
            while (!stopping) {
                const { done, value } = await reader.read();
                parser.push(decoder.decode(value, { stream: !done }));
                if (done) break;
            }
            parser.finish();
        } catch (error) {
            stop(error);
            throw error;
        } finally {
            // 正常 EOF 只需释放锁，异常路径由 stop 取消一次 reader，等待完成后再允许外层清理会话
            parser.decoder.onDelta = onDelta;
            parser.onEvent = onEvent;
            signal?.removeEventListener('abort', onAbort);
            try {
                await stopping;
            } finally {
                reader.releaseLock();
            }
        }

        // 用户取消优先于 INCOMPLETE 恢复
        signal?.throwIfAborted();
        const { message, ready } = parser.decoder.state;
        const error = Object.values(parser.decoder.state).flat().find(data => data?.type === 'error');
        const incomplete = message.response?.status === 'INCOMPLETE';
        if (!error && !incomplete) return;
        messageId = toNumberOrNull(message.response?.message_id) ?? toNumberOrNull(ready?.response_message_id);
        // 只有 INCOMPLETE 且具备续传方法和消息 ID 才能恢复，初次请求之后最多再请求3次
        if (!incomplete || !continueChat || messageId === null || retries >= 3) {
            throw new DeepSeekStreamError(error?.content ?? error?.message ?? (incomplete ? 'Response is incomplete' : 'Unknown error'), messageId);
        }
        try {
            stream = await continueChat(messageId);
        } catch (error) {
            // 续传请求失败时还没有可清理的 reader，使用已知消息 ID 调用停止方法
            await stopGeneration();
            throw error;
        }
    }
}

/** 读取响应并返回最后一次成功的文本、思考和用量 */
export async function parseResultFromStream(
    stream: ReadableStream<Uint8Array>,
    onDelta?: DeltaFn,
    options: StreamReadOptions = {},
) {
    const parser = new DeepseekStreamParser(onDelta);
    await readDeepseekStream(stream, parser, options);
    return {
        text: parser.text("RESPONSE").trim(),
        thinking: parser.text("THINK").trim(),
        messageId: toNumberOrNull(parser.decoder.state.message.response?.message_id)
                ?? toNumberOrNull(parser.decoder.state.ready?.response_message_id),
        accumulated_token_usage: parser.decoder.state.message.response?.accumulated_token_usage ?? -1,
    };
}

export function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

// DEMO: Read test.txt, parse, and output state as JSON
// import('fs').then(fs => {
//     fs.readFile('test.txt', 'utf8', (err, data) => {
//         if (err) {
//             console.error('Failed to read test.txt:', err);
//             return;
//         }
//         const parser = new DeepseekStreamParser();
//         parser.parseAll(data);
//         console.log(JSON.stringify(parser.decoder.state, null, 2));
//     });
// });
