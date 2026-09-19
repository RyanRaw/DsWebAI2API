import assert from "node:assert/strict";
import { chromium, type Request } from "playwright-core";
import { launchChromeForDebugging } from "../browser.js";
import { DeepSeekBrowserClient } from "../deepseekBrowserClient.js";
import { DeepseekStreamParser, toNumberOrNull } from "../deepseekStreamParser.js";

async function run() {
    const launched = await launchChromeForDebugging({ headless: false, detached: true });
    launched.process.unref();
    const browser = await chromium.connectOverCDP(launched.cdpUrl);
    const client = new DeepSeekBrowserClient(browser);
    const page = await client.page;
    await page.goto("https://chat.deepseek.com", { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    console.log("Visible browser opened. Sign in there if needed; waiting up to 2 minutes.");
    await page.locator('textarea[autocomplete="off"]').waitFor({ timeout: 120000 });

    const controller = new AbortController();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let continueTimer: ReturnType<typeof setTimeout> | undefined;
    let startedAt = 0;
    let stoppedAt = 0;
    let continuedAt = 0;
    let stopCount = 0;
    let continueCount = 0;
    let stopPayload: Record<string, unknown> | undefined;
    let continuePayload: Record<string, unknown> | undefined;
    const continueDue = Promise.withResolvers<void>();
    const onRequest = (request: Request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/v0/chat/completion" && !startedAt) {
            startedAt = performance.now();
            console.log("Completion sent; stopping in 1000 ms.");
            stopTimer = setTimeout(() => controller.abort(), 1000);
        } else if (pathname === "/api/v0/chat/stop_stream") {
            stoppedAt = performance.now();
            stopCount++;
            stopPayload = request.postDataJSON();
            console.log(`Stop sent at +${Math.round(stoppedAt - startedAt)} ms; continuing in 3000 ms.`);
            continueTimer = setTimeout(continueDue.resolve, 3000);
        } else if (pathname === "/api/v0/chat/continue") {
            continuedAt = performance.now();
            continueCount++;
            continuePayload = request.postDataJSON();
            console.log(`Continue sent ${Math.round(continuedAt - stoppedAt)} ms after stop.`);
        }
    };
    page.on("request", onRequest);
    const completion = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/v0/chat/completion", { timeout: 30000 });
    void completion.catch(() => undefined);

    try {
        const generation = client.chatCompletions({
            message: "\u4eca\u5929\u7684\u70ed\u641c\u662f\u4ec0\u4e48",
            modelType: "default",
            thinkingEnabled: true,
            searchEnabled: true,
            signal: controller.signal,
        });
        await assert.rejects(generation, { name: "AbortError" });
        assert.equal(stopCount, 1, "Expected one stop click");
        assert.equal(continueCount, 0, "Cancellation must not automatically continue");

        const response = await completion;
        assert.ok(response.ok(), `Completion HTTP ${response.status()}`);
        const payload = response.request().postDataJSON();
        assert.equal(payload.thinking_enabled, true);
        assert.equal(payload.search_enabled, true);
        const parser = new DeepseekStreamParser();
        parser.parseAll(await response.text());
        assert.equal(parser.decoder.state.message.response?.status, "INCOMPLETE");
        const messageId = toNumberOrNull(parser.decoder.state.ready?.response_message_id);
        assert.ok(messageId !== null, "Missing response message ID");
        assert.equal(stopPayload?.chat_session_id, payload.chat_session_id);
        assert.equal(stopPayload?.message_id, messageId);

        await continueDue.promise;
        const raw = await client.continueChat({ sessionId: payload.chat_session_id, messageId });
        assert.equal(continueCount, 1, "Expected one continue click");
        assert.equal(continuePayload?.chat_session_id, payload.chat_session_id);
        assert.equal(continuePayload?.message_id, messageId);
        assert.ok(stoppedAt - startedAt >= 950, "Stop was sent too early");
        assert.ok(continuedAt - stoppedAt >= 2950, "Continue was sent too early");
        const resumed = new DeepseekStreamParser();
        resumed.parseAll(raw);
        assert.equal(resumed.decoder.state.message.response?.status, "FINISHED");
        const text = resumed.text("RESPONSE");
        assert.ok(text.trim(), "No answer after continuing");
        assert.ok(text.startsWith(parser.text("RESPONSE")), "Continuation lost the original text prefix");
        console.log("PASS: thinking + search, stop, INCOMPLETE, continue, FINISHED.");
        console.log("Browser window and conversation kept open.");
        await new Promise<void>((resolve, reject) => {
            process.stdout.write(`\nFinal complete response:\n${text}\n`, error => error ? reject(error) : resolve());
        });
    } finally {
        clearTimeout(stopTimer);
        clearTimeout(continueTimer);
        page.off("request", onRequest);
    }
}

run().then(() => process.exit(0), error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`, () => process.exit(1));
});