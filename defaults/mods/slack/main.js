// Slack through Slack's official MCP server (https://mcp.slack.com/mcp), as you.
// Setup is one Keychain item holding a Slack user token (xoxp-) from an internal app with MCP enabled:
//   security add-generic-password -U -s herdr-slack-mcp -a slack -w "$(pbpaste)"
// Nothing is cached: every view is a live MCP call. Only the Send button posts.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextView } from "gpui-base";
import { exec, theme, window } from "herdr";

const MCP = "https://mcp.slack.com/mcp";
const SERVICE = "herdr-slack-mcp";
const SETUP = `security add-generic-password -U -s ${SERVICE} -a slack -w "$(pbpaste)"`;

// Accepts a Slack link (a message link opens its thread) or a channel/user ID, optionally followed by a label.
export function parseTarget(input) {
  const s = input.trim();
  const link = s.match(/slack\.com\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?(?:\?.*?thread_ts=(\d+\.\d+))?/);
  if (link) {
    const [, channel, sec, frac, parent] = link;
    return { channel, thread: parent ?? (sec ? `${sec}.${frac}` : "") };
  }
  const id = s.match(/^([CDGU][A-Z0-9]{6,})(?:\s+(.+))?$/);
  return id ? { channel: id[1], thread: "", name: id[2] } : null;
}

// Streamable HTTP answers with plain JSON or an SSE stream; the JSON-RPC reply is the last message with result/error.
export function rpcResult(body) {
  const lines = body.trimStart().startsWith("{") ? [body] : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5));
  const msg = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && ("result" in m || "error" in m)).pop();
  if (!msg) throw new Error("Slack MCP returned an unreadable response.");
  if (msg.error) throw new Error(`Slack MCP: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const text = (msg.result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n\n");
  if (msg.result.isError) throw new Error(text || "Slack MCP tool failed.");
  // Slack wraps its markdown in a JSON envelope like {"messages": "...", "pagination_info": "..."}.
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.values(obj).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n\n");
    }
  } catch {}
  return text;
}

const keyOf = (v) => JSON.stringify([v?.channel ?? "", v?.thread ?? ""]);

export default class Slack extends View {
  init() {
    this.recent = JSON.parse(localStorage.getItem("recent") ?? "[]");
    this.drafts = new Map(); this.unsure = new Set();
    this.target = InputState.new({ placeholder: "Channel or user ID (C0123 label), or paste a Slack link" });
    this.searchInput = InputState.new({ placeholder: "Search Slack: words, in:#channel, from:@user, after:2026-01-01" });
    this.composer = InputState.new({ placeholder: "Write a message. Only Send posts to Slack." });
    this.target.on("submit", (_e, cx) => this.go(cx));
    this.searchInput.on("submit", (_e, cx) => this.search(cx));
  }

  async token() {
    if (this.tokenValue) return this.tokenValue;
    const r = await exec("security", ["find-generic-password", "-s", SERVICE, "-w"]);
    if (r.code !== 0) throw new Error(`No Slack token in Keychain. Copy your xoxp- user token, then run: ${SETUP}`);
    return (this.tokenValue = r.stdout.trim());
  }

  // ponytail: stateless tools/call, no initialize or Mcp-Session-Id; mod fetch can't read response headers.
  // If Slack starts requiring sessions, fetch must expose headers first.
  async call(name, args) {
    const r = await fetch(MCP, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    if (r.status === 401) this.tokenValue = null;
    return rpcResult(await r.text());
  }

  show(view, cx) {
    this.drafts.set(keyOf(this.view), this.composer.value());
    this.view = view; this.output = ""; this.note = null;
    this.composer.set_value(this.drafts.get(keyOf(view)) ?? "");
    this.load(cx);
  }

  load(cx) {
    const v = this.view;
    if (!v) return;
    const [tool, args] = v.query ? ["slack_search_public_and_private", { query: v.query, limit: 20 }]
      : v.find ? ["slack_search_channels", { query: v.find, channel_types: "public_channel,private_channel" }]
      : v.thread ? ["slack_read_thread", { channel_id: v.channel, message_ts: v.thread }]
      : ["slack_read_channel", { channel_id: v.channel, limit: 50 }];
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try { const text = await this.call(tool, args); if (this.view === v) this.output = text; }
      catch (e) { if (this.view === v) this.error = String(e.message ?? e); }
      finally { if (this.view === v) this.loading = false; cx.notify(); }
    });
  }

  remember(t) {
    this.recent = [t, ...this.recent.filter((r) => keyOf(r) !== keyOf(t))].slice(0, 30);
    localStorage.setItem("recent", JSON.stringify(this.recent));
  }

  forget(t, cx) {
    this.recent = this.recent.filter((r) => keyOf(r) !== keyOf(t));
    localStorage.setItem("recent", JSON.stringify(this.recent));
    cx.notify();
  }

  go(cx) {
    const input = this.target.value().trim();
    if (!input) return;
    const t = parseTarget(input);
    if (t) {
      const old = this.recent.find((r) => keyOf(r) === keyOf(t));
      this.remember({ ...t, name: t.name ?? old?.name ?? "" });
      this.show(t, cx);
    } else {
      this.show({ find: input.replace(/^#/, "") }, cx);
    }
    this.target.set_value("");
  }

  search(cx) {
    const query = this.searchInput.value().trim();
    if (query) this.show({ query }, cx);
  }

  send(cx) {
    const v = this.view, k = keyOf(v), text = this.composer.value().trim();
    if (this.sending || !text || !v?.channel || this.unsure.has(k)) return;
    this.sending = true; this.note = null; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.call("slack_send_message", { channel_id: v.channel, message: text, ...(v.thread ? { thread_ts: v.thread } : {}) });
        this.drafts.delete(k);
        if (this.view === v) {
          if (this.composer.value().trim() === text) this.composer.set_value("");
          this.note = "Sent to Slack.";
          this.load(cx);
        }
      } catch (e) {
        // A failed send may still have posted: block resending this target until the person checks Slack.
        this.unsure.add(k);
        if (this.view === v) this.error = `${e.message ?? e}. The message may have been posted: check Slack, then Clear draft before trying again.`;
      } finally { this.sending = false; cx.notify(); }
    });
  }

  clearDraft(cx) {
    if (this.sending) return;
    const k = keyOf(this.view);
    this.unsure.delete(k); this.drafts.delete(k);
    this.composer.set_value(""); this.error = null; this.note = null;
    cx.notify();
  }

  button(t, id, label, action) {
    return div().id(id).px(9).h(28).flex().items_center().rounded(5).border(1).border_color(t.border)
      .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  input(t, id, state) {
    return div().id(id).flex_1().min_w(0).h(32).px(8).flex().items_center().rounded(5).border(1).border_color(t.input)
      .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(13).text_color(t.foreground));
  }

  label(r) {
    return `${r.name || r.channel}${r.thread ? " / thread" : ""}`;
  }

  render() {
    const t = theme(), v = this.view, k = keyOf(v);
    const w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const title = !v ? "Slack" : v.query ? `Search: ${v.query}` : v.find ? `Channels matching: ${v.find}`
      : this.label(this.recent.find((r) => keyOf(r) === k) ?? v);
    const sidebar = v_flex().id("slack-recent").w(220).flex_none().h_full().overflow_y_scrollbar()
      .bg(t.chrome).border_r(1).border_color(t.border).p(10).gap(6)
      .child(div().h(28).pl(lights ? 20 : 0).flex().items_center().font_semibold().child("Slack"))
      .child(div().text_size(11).text_color(t.muted).child("Recent channels, DMs and threads. Live from Slack MCP; nothing is cached."))
      .children(this.recent.map((r, i) => h_flex().id(`slack-recent-${i}`).px(6).py(4).gap(6).items_center().rounded(5)
        .bg(keyOf(r) === k ? t.selected : t.chrome).hover((s) => s.bg(t.hover))
        .child(div().id(`slack-open-${i}`).flex_1().min_w(0).truncate().text_size(13).cursor_pointer().tooltip(`${r.channel} ${r.thread}`)
          .on_click((_e, cx) => this.show(r, cx)).child(this.label(r)))
        .child(div().id(`slack-forget-${i}`).text_size(12).text_color(t.muted).cursor_pointer()
          .on_click((_e, cx) => this.forget(r, cx)).child("×"))));
    const page = v_flex().flex_1().min_w(0).h_full().p(12).gap(10)
      .child(h_flex().gap(8).items_center()
        .child(this.input(t, "slack-target-input", this.target))
        .child(this.button(t, "slack-go", "Open", (_e, cx) => this.go(cx))))
      .child(h_flex().gap(8).items_center()
        .child(this.input(t, "slack-search-input", this.searchInput))
        .child(this.button(t, "slack-search", "Search", (_e, cx) => this.search(cx))))
      .child(h_flex().items_center().gap(8).child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
        .when(Boolean(v?.channel && v.thread), (el) => el.child(this.button(t, "slack-back", "Channel", (_e, cx) => this.show({ channel: v.channel, thread: "" }, cx))))
        .when(Boolean(v), (el) => el.child(this.button(t, "slack-refresh", this.loading ? "Loading..." : "Refresh", (_e, cx) => this.load(cx)))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(t.muted).child(this.note)))
      .child(v_flex().id("slack-output").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().text_size(13)
        .child(this.output ? TextView.markdown("slack-markdown", this.output).selectable(true)
          : div().text_color(t.muted).child(this.loading ? "Asking Slack..." : v ? "Nothing here." :
            "Open a channel or DM by ID, paste a Slack message link to open its thread, type a name to find channels, or search.")))
      .when(Boolean(v?.channel), (el) => el
        .child(h_flex().gap(8).items_center()
          .child(this.input(t, "slack-composer", this.composer))
          .child(this.button(t, "slack-send", this.sending ? "Sending..." : this.unsure.has(k) ? "Check Slack first" : v.thread ? "Send reply" : "Send message", (_e, cx) => this.send(cx)))
          .child(this.button(t, "slack-clear", "Clear draft", (_e, cx) => this.clearDraft(cx))))
        .child(div().text_size(11).text_color(t.muted).child(`Posts as you to ${title}. Enter does not send.`)));
    return h_flex().size_full().bg(t.background).text_color(t.foreground).child(sidebar).child(page);
  }
}
