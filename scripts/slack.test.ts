import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/slack/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export (default )?/gm, "");
const InputState = { new: () => ({ text: "", value() { return this.text; }, set_value(text: string) { this.text = text; }, on() {} }) };
const store = new Map<string, string>();
const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
const { Slack, parseTarget, rpcResult } = new Function("View", "InputState", "localStorage",
  `${source}; return { Slack, parseTarget, rpcResult };`)(class {}, InputState, localStorage);

test("Slack links and IDs open the right channel or thread", () => {
  expect(parseTarget("https://acme.slack.com/archives/C016VCYCL74/p1727122965001469"))
    .toEqual({ channel: "C016VCYCL74", thread: "1727122965.001469" });
  expect(parseTarget("https://acme.slack.com/archives/C016VCYCL74/p1727122965001469?thread_ts=1727122900.000100&cid=C016VCYCL74"))
    .toEqual({ channel: "C016VCYCL74", thread: "1727122900.000100" });
  expect(parseTarget("https://acme.slack.com/archives/D0123456")).toEqual({ channel: "D0123456", thread: "" });
  expect(parseTarget("C0123456 deploys")).toEqual({ channel: "C0123456", thread: "", name: "deploys" });
  expect(parseTarget("#deploys")).toBeNull();
});

test("MCP replies parse from JSON or SSE, and errors surface", () => {
  const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hello" }] } };
  expect(rpcResult(JSON.stringify(ok))).toBe("hello");
  expect(rpcResult(`event: message\ndata: ${JSON.stringify(ok)}\n\n`)).toBe("hello");
  const wrapped = { id: 1, result: { content: [{ type: "text", text: '{"messages":"# Hi","pagination_info":"End"}' }] } };
  expect(rpcResult(JSON.stringify(wrapped))).toBe("# Hi\n\nEnd");
  expect(() => rpcResult('{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"invalid_auth"}}')).toThrow("invalid_auth");
  expect(() => rpcResult(JSON.stringify({ id: 1, result: { isError: true, content: [{ type: "text", text: "channel_not_found" }] } }))).toThrow("channel_not_found");
});

test("a failed send blocks resending to that target until the draft is cleared", async () => {
  const tasks: Promise<unknown>[] = [];
  const cx = { notify() {}, spawn(fn: (cx: unknown) => Promise<unknown>) { tasks.push(fn(cx)); } };
  const view = new Slack();
  view.init({}, cx);
  const calls: string[] = [];
  view.call = async (tool: string) => { calls.push(tool); if (tool === "slack_send_message") throw new Error("connection lost"); return "history"; };
  view.show({ channel: "C01", thread: "" }, cx);
  view.composer.set_value("hello");
  view.send(cx);
  await Promise.all(tasks.splice(0));
  expect(view.error).toContain("may have been posted");
  expect(view.composer.value()).toBe("hello");
  view.send(cx);
  await Promise.all(tasks.splice(0));
  expect(calls.filter((c) => c === "slack_send_message")).toHaveLength(1);
  view.clearDraft(cx);
  view.composer.set_value("hello again");
  view.send(cx);
  await Promise.all(tasks.splice(0));
  expect(calls.filter((c) => c === "slack_send_message")).toHaveLength(2);
});
