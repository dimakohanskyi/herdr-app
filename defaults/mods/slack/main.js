// Slack through Slack's official MCP server (https://mcp.slack.com/mcp), as you.
// Setup is one Keychain item holding a Slack user token (xoxp-) from an internal app with MCP enabled:
//   security add-generic-password -U -s herdr-slack-mcp -a slack -w "$(pbpaste)"
// Nothing is cached: every view is a live MCP call. Enter or Send posts; nothing else does.
// Every minute it checks DMs and the #prod-alerts / #stage-alerts channels and posts a notification for new messages.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle, TextView } from "gpui-base";
import { checking, exec, layout, notify, theme, window } from "herdr";

const MCP = "https://mcp.slack.com/mcp";
const SERVICE = "herdr-slack-mcp";
const SETUP = `security add-generic-password -U -s ${SERVICE} -a slack -w "$(pbpaste)"`;
const POLL_MS = 60000;
const ALERTS = /^#(prod|stage)-alerts$/;

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

// slack_list_user_channels answers in markdown: "### #name", "- **ID:** C0..." and, for DMs, "- **Members:** ... with: @a, @b".
export function parseChannels(md) {
  return md.split(/^### /m).slice(1).map((b) => {
    const id = b.match(/\*\*ID:\*\* ([A-Z0-9]+)/)?.[1];
    const who = b.match(/\*\*Members:\*\*.*?with:? (.+)/)?.[1];
    return id && { channel: id, thread: "", name: (who ?? b.split("\n")[0]).trim() };
  }).filter(Boolean);
}

// Slack's own markup: <@U1|Name>, <#C1|name>, <url|label>, <url>.
const unslack = (s) => s.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1").replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
  .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)").replace(/<(https?:[^>]+)>/g, "$1");

// One message block: "Name <mail> (U1)" as author, the quoted lines as text, "Thread: N replies" and "Reactions:" pulled out.
function message(block, head) {
  const who = head.match(/^(.*?)\s*(?:<[^>]*>)?\s*\(([A-Z0-9]+)\)/) ?? [];
  const ts = block.match(/^Message[ _]TS: (\S+)/mi)?.[1];
  const time = head.match(/ at (.+?) ===/)?.[1] ?? block.match(/^Time: (.+)$/m)?.[1]?.trim() ?? "";
  const lines = block.split("\n").filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, ""));
  const replies = Number(lines.find((l) => /^Thread: \d+ repl/.test(l))?.match(/\d+/)[0] ?? 0);
  const reactions = lines.find((l) => l.startsWith("Reactions: "))?.slice(11) ?? "";
  const text = unslack(lines.filter((l) => !/^Thread: \d+ repl/.test(l) && !l.startsWith("Reactions: ")).join("\n").trim());
  return ts && { author: who[1]?.trim() || "Bot", user: who[2] ?? "", time, ts, text, replies, reactions };
}

// slack_read_channel ("=== Message from Name (U1) at <time> ===") and slack_read_thread ("From: Name (U1)" / "Time:")
// both answer newest first in markdown; chat order is oldest first.
export function parseMessages(md) {
  return md.split(/^(?====|---)/m).map((b) => {
    const head = b.match(/^=== Message from (.*)/)?.[1] ?? b.match(/^From: (.*)$/m)?.[1];
    return head && message(b, head);
  }).filter(Boolean).sort((a, b) => Number(a.ts) - Number(b.ts));
}

// slack_search_public_and_private: "### Result n", "Channel: DM (ID: D1)", "From: Name (ID: U1)", "Message_ts:", "Text:" then quoted lines.
export function parseSearch(md) {
  return md.split(/^### Result /m).slice(1).map((b) => {
    const channel = b.match(/^Channel: .*?\(ID: ([A-Z0-9]+)\)/m)?.[1];
    const m = message(b, (b.match(/^From: (.*)$/m)?.[1] ?? "").replace("(ID: ", "("));
    return channel && m && { ...m, channel };
  }).filter(Boolean);
}

const keyOf = (v) => JSON.stringify([v?.channel ?? "", v?.thread ?? ""]);
const firstLine = (s) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Slack extends View {
  init(_props, cx) {
    this.recent = JSON.parse(localStorage.getItem("recent") ?? "[]");
    this.drafts = new Map(); this.unsure = new Set(); this.unread = new Set(); this.channels = []; this.messages = null;
    this.since = {}; this.start = Date.now() / 1000; // nothing from before this start is announced
    this.scroll = ScrollHandle.new();
    this.filter = InputState.new({ placeholder: "Filter" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.target = InputState.new({ placeholder: "Search Slack, or paste a Slack link / channel ID" });
    this.composer = InputState.new({ placeholder: "Message" });
    this.target.on("submit", (_e, cx) => this.go(cx));
    this.composer.on("submit", (_e, cx) => this.send(cx));
    if (checking()) return;
    this.loadChannels(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.timer.every(500, (cx) => this.watchShown(cx));
  }

  // The Slack screen is one child of the "screens" stack; a layout without it shows Slack all the time.
  shown() {
    const screens = find(layout(), "screens");
    return !screens || screens.active === "slack";
  }

  // A notification click selects the Slack screen; the chat it was about opens when the screen shows.
  watchShown(cx) {
    const shown = this.shown();
    if (shown && !this.wasShown && this.jump) { this.show(this.jump, cx); this.jump = null; }
    this.wasShown = shown;
  }

  // ponytail: up to 5 pages of 200; raise the cap if someone is in more than 1000 conversations.
  loadChannels(cx) {
    if (this.channelsLoading) return;
    this.channelsLoading = true; this.channelsError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const all = [];
        let cursor;
        for (let page = 0; page < 5; page++) {
          const md = await this.call("slack_list_user_channels", { types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
          all.push(...parseChannels(md));
          cursor = md.match(/Use cursor: "([^"]+)"/)?.[1];
          if (!cursor) break;
        }
        this.channels = all.sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { this.channelsError = String(e.message ?? e); }
      finally { this.channelsLoading = false; cx.notify(); }
    });
  }

  // New DMs (one search) and new alerts (one read per alerts channel), each newer than what this copy already saw.
  // ponytail: Slack's search index can lag a few seconds; a DM that lands late is still caught next minute because `since` only moves to what was seen.
  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        this.me ??= (await this.call("slack_read_user_profile", {})).match(/^User ID: (\S+)/m)?.[1];
        const fresh = [];
        const dmSince = this.since.dm ?? this.start;
        const day = new Date((dmSince - 86400) * 1000).toISOString().slice(0, 10);
        const dms = parseSearch(await this.call("slack_search_public_and_private",
          { filters: `after:${day}`, channel_types: "im,mpim", sort: "timestamp", after: Math.floor(dmSince), limit: 20, include_context: false }))
          .filter((m) => Number(m.ts) > dmSince);
        if (dms.length) this.since.dm = Math.max(...dms.map((m) => Number(m.ts)));
        fresh.push(...dms);
        for (const c of this.channels.filter((c) => ALERTS.test(c.name))) {
          const since = this.since[c.channel] ?? this.start;
          const msgs = parseMessages(await this.call("slack_read_channel", { channel_id: c.channel, oldest: String(since), limit: 20 }))
            .filter((m) => Number(m.ts) > since);
          if (msgs.length) this.since[c.channel] = Number(msgs.at(-1).ts);
          fresh.push(...msgs.map((m) => ({ ...m, channel: c.channel })));
        }
        this.announce(fresh.filter((m) => m.user !== this.me), cx);
        // The open chat stays live while it's on screen.
        if (this.shown() && this.view?.channel && !this.loading) this.load(cx, true);
      } catch {} // ponytail: a failed check is retried next minute; the open chat shows its own errors
      finally { this.polling = false; cx.notify(); }
    });
  }

  // One notification per chat: its newest message, and how many came.
  announce(msgs, cx) {
    const byChat = new Map();
    for (const m of msgs) byChat.set(m.channel, [...(byChat.get(m.channel) ?? []), m]);
    for (const [channel, list] of byChat) {
      const open = this.shown() && this.view?.channel === channel && !this.view.thread;
      if (open) continue;
      this.unread.add(channel);
      const last = list.at(-1), name = this.channels.find((c) => c.channel === channel)?.name ?? last.author;
      this.jump = { channel, thread: "" };
      notify({
        title: list.length > 1 ? `${name} (${list.length} new)` : name,
        body: `${last.author}: ${firstLine(last.text)}`,
        level: /:red_circle:|\[ALARM\]/.test(last.text) ? "error" : "info",
        source: "slack",
        action: { name: "layout.select", args: { stack: "screens", child: "slack" } },
      });
    }
    if (byChat.size) cx.notify();
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
    this.view = view; this.output = ""; this.messages = null; this.note = null;
    if (view.channel && !view.thread) this.unread.delete(view.channel);
    this.composer.set_value(this.drafts.get(keyOf(view)) ?? "");
    this.load(cx);
  }

  // quiet: a background refresh keeps what's on screen and only scrolls when a newer message came.
  load(cx, quiet = false) {
    const v = this.view;
    if (!v) return;
    const [tool, args] = v.query ? ["slack_search_public_and_private", { query: v.query, limit: 20 }]
      : v.find ? ["slack_search_channels", { query: v.find, channel_types: "public_channel,private_channel" }]
      : v.thread ? ["slack_read_thread", { channel_id: v.channel, message_ts: v.thread }]
      : ["slack_read_channel", { channel_id: v.channel, limit: 50 }];
    this.loading = true; if (!quiet) this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await this.call(tool, args);
        if (this.view !== v) return;
        const msgs = v.channel ? parseMessages(text) : [];
        const newest = (list) => list?.at(-1)?.ts;
        if (msgs.length && newest(msgs) !== newest(this.messages)) this.toBottom = true;
        // A reply that doesn't split into messages still shows, as Slack wrote it.
        this.messages = msgs.length ? msgs : null; this.output = text; this.error = null;
      } catch (e) { if (this.view === v && !quiet) this.error = String(e.message ?? e); }
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

  // A link or ID opens that chat; a "#name" finds channels; anything else is a Slack search.
  go(cx) {
    const input = this.target.value().trim();
    if (!input) return;
    const t = parseTarget(input);
    if (t) {
      const old = this.recent.find((r) => keyOf(r) === keyOf(t));
      this.remember({ ...t, name: t.name ?? old?.name ?? "" });
      this.show(t, cx);
    } else if (input.startsWith("#")) {
      this.show({ find: input.slice(1) }, cx);
    } else {
      this.show({ query: input }, cx);
    }
    this.target.set_value("");
  }

  open(c, cx) {
    this.remember({ channel: c.channel, thread: c.thread ?? "", name: c.name ?? "" });
    this.show(c, cx);
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
          this.load(cx, true);
        }
      } catch (e) {
        // A failed send may still have posted: block resending this target until the person checks Slack.
        this.unsure.add(k);
        if (this.view === v) this.error = `${e.message ?? e}. The message may have been posted: check Slack, then Clear before trying again.`;
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
    return div().id(id).flex_none().px(10).h(30).flex().items_center().rounded(6).border(1).border_color(t.border)
      .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  input(t, id, state) {
    return div().id(id).flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(6).border(1).border_color(t.input).bg(t.surface)
      .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(13).text_color(t.foreground));
  }

  label(r) {
    return `${r.name || r.channel}${r.thread ? " / thread" : ""}`;
  }

  row(t, id, c, k, label, trailing) {
    const unread = !c.thread && this.unread.has(c.channel);
    return h_flex().id(id).flex_none().px(8).h(28).gap(6).items_center().rounded(6).cursor_pointer()
      .bg(keyOf(c) === k ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).tooltip(`${c.channel} ${c.thread ?? ""}`)
      .on_click((_e, cx) => this.open(c, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(13).when(unread, (el) => el.font_semibold()).child(label))
      .when(unread, (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.accent)))
      .when(Boolean(trailing), (el) => el.child(trailing));
  }

  heading(t, text) {
    return div().flex_none().pt(8).px(8).text_size(11).font_semibold().text_color(t.muted).child(text);
  }

  // Oldest at the top, newest at the bottom; a date line where the day changes; a run from one author shows the name once.
  chat(t, msgs) {
    const rows = [];
    msgs.forEach((m, i) => {
      const prev = msgs[i - 1], day = m.time.slice(0, 10);
      if (day !== prev?.time.slice(0, 10)) rows.push(h_flex().flex_none().py(8).gap(8).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_1().h(1).bg(t.border)).child(day).child(div().flex_1().h(1).bg(t.border)));
      const same = prev && prev.user === m.user && day === prev.time.slice(0, 10) && Number(m.ts) - Number(prev.ts) < 300;
      rows.push(v_flex().id(`slack-msg-${m.ts}`).flex_none().text_size(13).px(10).pt(same ? 1 : 8).pb(2).rounded(6).hover((s) => s.bg(t.hover))
        .when(!same, (el) => el.child(h_flex().gap(8).items_baseline()
          .child(div().text_size(13).font_semibold().child(m.author))
          .child(div().text_size(11).text_color(t.muted).child(m.time.slice(11, 16)))))
        .child(TextView.markdown(`slack-text-${m.ts}`, m.text || "_(no text)_").selectable(true))
        .when(Boolean(m.reactions), (el) => el.child(div().pt(2).text_size(11).text_color(t.muted).child(m.reactions)))
        .when(m.replies > 0 && !this.view.thread, (el) => el.child(div().id(`slack-thread-${m.ts}`).pt(2).text_size(12)
          .text_color(t.accent).cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => this.open({ channel: this.view.channel, thread: m.ts, name: this.title() }, cx))
          .child(`${m.replies} ${m.replies === 1 ? "reply" : "replies"}`))));
    });
    return rows;
  }

  title() {
    const v = this.view, k = keyOf(v);
    if (!v) return "Slack";
    if (v.query) return `Search: ${v.query}`;
    if (v.find) return `Channels matching: ${v.find}`;
    const base = this.channels.find((c) => c.channel === v.channel) ?? this.recent.find((r) => keyOf(r) === k) ?? v;
    return this.label({ ...base, thread: v.thread });
  }

  render() {
    const t = theme(), v = this.view, k = keyOf(v);
    const w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const title = this.title();
    const q = this.filter.value().trim().toLowerCase().replace(/^#/, "");
    const match = (c) => !q || (c.name || c.channel).toLowerCase().replace(/^#/, "").includes(q);
    const channels = this.channels.filter(match), recent = this.recent.filter(match);
    const sidebar = v_flex().id("slack-sidebar").w(240).flex_none().h_full().overflow_y_scrollbar()
      .bg(t.chrome).border_r(1).border_color(t.border).px(8).pb(10).gap(1)
      .child(h_flex().flex_none().h(38).pl(lights ? 28 : 8).items_center().font_semibold().child("Slack"))
      .child(h_flex().flex_none().pb(4).child(this.input(t, "slack-filter", this.filter)))
      .when(recent.length > 0, (el) => el.child(this.heading(t, "Recent")))
      .children(recent.map((r, i) => this.row(t, `slack-recent-${i}`, r, k, this.label(r),
        div().id(`slack-forget-${i}`).flex_none().px(4).text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.forget(r, cx); }).child("×"))))
      .child(h_flex().flex_none().items_center().pr(8)
        .child(div().flex_1().child(this.heading(t, this.channelsLoading ? "Loading channels..." : `Channels and DMs (${channels.length})`)))
        .child(div().id("slack-channels-reload").pt(8).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.loadChannels(cx)).child("Reload")))
      .when(Boolean(this.channelsError), (el) => el.child(div().px(8).text_size(11).text_color(t.ansi1).child(this.channelsError)))
      .children(channels.map((c) => this.row(t, `slack-channel-${c.channel}`, c, k, c.name)));

    const header = h_flex().flex_none().h(48).px(16).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .when(Boolean(v?.channel && v.thread), (el) => el.child(this.button(t, "slack-back", "← Channel", (_e, cx) => this.show({ channel: v.channel, thread: "" }, cx))))
      .when(Boolean(v), (el) => el.child(this.button(t, "slack-refresh", this.loading ? "Loading..." : "Refresh", (_e, cx) => this.load(cx))))
      .child(div().w(280).flex_none().flex().child(this.input(t, "slack-target-input", this.target)));

    const rows = this.messages ? this.chat(t, this.messages) : [];
    // The last child is a spacer: revealing it puts the newest message fully on screen.
    if (this.toBottom && rows.length) { this.toBottom = false; this.scroll.scroll_to_item(rows.length); }
    const body = this.messages
      ? v_flex().id("slack-output").flex_1().min_h(0).min_w(0).px(6).py(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows).child(div().flex_none().h(4))
      : v_flex().id("slack-output").flex_1().min_h(0).min_w(0).px(16).py(12).overflow_y_scrollbar().text_size(13)
        .child(this.output ? TextView.markdown("slack-markdown", this.output).selectable(true)
          : div().text_color(t.muted).child(this.loading ? "Asking Slack..." : v ? "Nothing here." :
            "Pick a channel or DM on the left, paste a Slack message link to open its thread, or search."));

    const composer = Boolean(v?.channel) && v_flex().flex_none().px(16).pb(14).pt(6).gap(4)
      .child(h_flex().gap(8).items_center()
        .child(this.input(t, "slack-composer", this.composer).h(38))
        .when(this.unsure.has(k), (el) => el.child(this.button(t, "slack-clear", "Clear", (_e, cx) => this.clearDraft(cx))))
        .child(this.button(t, "slack-send", this.sending ? "Sending..." : this.unsure.has(k) ? "Check Slack first" : v.thread ? "Reply" : "Send", (_e, cx) => this.send(cx)).h(38)))
      .child(div().text_size(11).text_color(t.muted).child(`Enter posts as you to ${title}.`));

    const page = v_flex().flex_1().min_w(0).h_full()
      .child(header)
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(16).pt(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(16).pt(8).text_size(12).text_color(t.muted).child(this.note)))
      .child(body)
      .when(Boolean(composer), (el) => el.child(composer));
    return h_flex().size_full().bg(t.background).text_color(t.foreground).child(sidebar).child(page);
  }
}
