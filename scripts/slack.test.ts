import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/slack/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export (default )?/gm, "");
const InputState = { new: () => ({ text: "", value() { return this.text; }, set_value(text: string) { this.text = text; }, on() {} }) };
const store = new Map<string, string>();
const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
const notes: { title: string; body?: string }[] = [];
const { Slack, parseTarget, rpcResult, parseChannels, parseMessages, parseSearch } = new Function("View", "InputState", "ScrollHandle", "localStorage", "checking", "notify", "layout",
  `${source}; return { Slack, parseTarget, rpcResult, parseChannels, parseMessages, parseSearch };`)(
  class {}, InputState, { new: () => ({ scroll_to_item() {} }) }, localStorage, () => true, (n: { title: string }) => notes.push(n), () => null);

test("channel history and threads read as chat: oldest first, with author, replies and reactions", () => {
  const history = "Channel: #ops (C01)\n\n"
    + "=== Message from Ann <ann@x.io> (U2) at 2026-11-26 09:00:05 CET === \nMessage TS: 1795680005.000200\n> see <https://x.io|the run>\n> Thread: 2 replies (latest: 2026-11-26 09:10:00 CET)\n> Reactions: eyes (1)\n\n"
    + "=== Message from  (B9) at 2026-11-25 23:00:00 CET === \nMessage TS: 1795644000.000100\n> :red_circle: [ALARM] api\n> Region: EU\n";
  expect(parseMessages(history)).toEqual([
    { author: "Bot", user: "B9", time: "2026-11-25 23:00:00 CET", ts: "1795644000.000100", text: ":red_circle: [ALARM] api\nRegion: EU", replies: 0, reactions: "" },
    { author: "Ann", user: "U2", time: "2026-11-26 09:00:05 CET", ts: "1795680005.000200", text: "see [the run](https://x.io)", replies: 2, reactions: "eyes (1)" },
  ]);
  const thread = "=== THREAD PARENT MESSAGE ===\nFrom: Ann <ann@x.io> (U2)\nTime: 2026-11-26 09:00:05 CET\nMessage TS: 1.1\n> question\n\n"
    + "=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Bob (U3)\nTime: 2026-11-26 09:01:00 CET\nMessage TS: 1.2\n> answer <@U2|Ann>\n";
  expect(parseMessages(thread).map((m: { author: string; text: string }) => `${m.author}: ${m.text}`)).toEqual(["Ann: question", "Bob: answer @Ann"]);
});

test("new DMs and alerts notify once per chat, never for my own or already seen messages", async () => {
  const search = (ts: string, from: string) => `### Result 1 of 1\nChannel: DM (ID: D1)\nFrom: ${from} (ID: ${from === "Me" ? "U1" : "U2"})\nTime: 2026-11-26 09:00:00 CET\nMessage_ts: ${ts}\nText: \n> hi there\n\n---\n`;
  const tasks: Promise<unknown>[] = [];
  const cx = { notify() {}, spawn(fn: (cx: unknown) => Promise<unknown>) { tasks.push(fn(cx)); } };
  const view = new Slack();
  view.init({}, cx);
  view.start = 100;
  view.channels = [{ channel: "C7", thread: "", name: "#prod-alerts" }, { channel: "D1", thread: "", name: "DM with Ann" }];
  let dm = search("150.1", "Ann") + search("160.1", "Me").replace("Result 1", "Result 2");
  const alerts = "=== Message from  (B9) at 2026-11-26 09:00:00 CET === \nMessage TS: 90.1\n> old\n\n=== Message from  (B9) at 2026-11-26 09:00:00 CET === \nMessage TS: 120.1\n> :red_circle: [ALARM] api down\n";
  view.call = async (tool: string) => tool === "slack_read_user_profile" ? "User ID: U1\n" : tool === "slack_read_channel" ? alerts : dm;
  notes.length = 0;
  view.poll(cx);
  await Promise.all(tasks.splice(0));
  expect(notes.map((n) => `${n.title} | ${n.body}`)).toEqual(["DM with Ann | Ann: hi there", "#prod-alerts | Bot: :red_circle: [ALARM] api down"]);
  expect([...view.unread]).toEqual(["D1", "C7"]);
  view.poll(cx);
  await Promise.all(tasks.splice(0));
  expect(notes).toHaveLength(2);
});

test("the channel list reads channels and DMs from slack_list_user_channels", () => {
  const md = "## My Channels (showing 2)\n\n### #deploys\n- **ID:** C09RB74CQFR\n- **Type:** Public Channel\n- **Archived:** No\n\n"
    + "### Group DM\n- **ID:** C0A2WKMRE94\n- **Type:** Group DM\n- **Members:** Group messaging with: @stan, @me\n\n---\nPagination: More results available. Use cursor: \"abc\"\n";
  expect(parseChannels(md)).toEqual([
    { channel: "C09RB74CQFR", thread: "", name: "#deploys" },
    { channel: "C0A2WKMRE94", thread: "", name: "@stan, @me" },
  ]);
});

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
