// How notifications look. Anything can post one with notify({ title, body,
// level, icon, source, action }); replace this mod to restyle them all. Click
// to run its action (e.g. go to the agent) and dismiss it. `source` picks the
// look: "agent", "slack", "jira", anything else is labeled as given, none is Herdr.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

// Theme colors (ansi follows the theme), so every look fits light and dark.
const SOURCES = {
  agent: { label: "Agent", glyph: ">_", color: (t) => t.accent },
  slack: { label: "Slack", glyph: "#", color: (t) => t.ansi5 },
  jira: { label: "Jira", glyph: "J", color: (t) => t.ansi4 },
  herdr: { label: "Herdr", glyph: "H", color: (t) => t.muted },
};
const LEVEL = { error: "blocked", warning: "working", success: "done" };
const STATUS = { error: "urgent", warning: "warning", success: "done" };
const tint = (c, a) => `${(c ?? "#888888").slice(0, 7)}${a}`;

const look = (p, t) => {
  const key = typeof p.source === "string" && p.source ? p.source.toLowerCase() : "herdr";
  const src = SOURCES[key] ?? { label: p.source, glyph: p.source.slice(0, 1).toUpperCase(), color: (t) => t.ansi6 };
  const color = src.color(t) ?? t.accent;
  // An error or warning outranks the source's own color: you see it's urgent first.
  const stripe = t[LEVEL[p.level]] ?? color;
  return { ...src, color, stripe, status: STATUS[p.level] };
};

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const l = look(p, t);
    const text = (value) => p.fitHeight
      ? div().child(value)
      : div().truncate().child(typeof value === "string" ? value.split("\n", 1)[0] : value);
    const badge = p.icon
      ? image(p.icon).w(18).h(18)
      : div().text_size(12).font_semibold().text_color(l.color).child(l.glyph);
    return h_flex()
      .id("toast")
      .when(p.fitHeight, (el) => el.w_full().min_h(70).flex_none())
      .when(!p.fitHeight, (el) => el.size_full())
      .items_stretch()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(div().w(4).flex_none().bg(l.stripe))
      .child(h_flex()
        .flex_1()
        .min_w(0)
        .pl(14)
        .pr(18)
        .when(p.fitHeight, (el) => el.py(12))
        .gap(12)
        .items_center()
        .child(h_flex().size(30).flex_none().rounded(8).items_center().justify_center()
          .bg(tint(l.color, "22")).border_1().border_color(tint(l.color, "55")).child(badge))
        .child(
          v_flex()
            .flex_1()
            .overflow_hidden()
            .gap(1)
            .child(h_flex().gap(6).items_center()
              .child(div().text_size(10).font_semibold().text_color(l.color).child(l.label.toUpperCase()))
              .when(Boolean(l.status), (el) => el.child(div().px(5).rounded(3).bg(tint(l.stripe, "26"))
                .text_size(10).text_color(l.stripe).child(l.status))))
            .child(text(login ? `${login[1]} needs a login: run` : p.title ?? "").font_semibold().text_size(13).text_color(t.foreground))
            .when(!login && Boolean(p.body), (el) => el.child(text(p.body).text_size(12).text_color(t.muted)))
            .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
              .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
              .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
                .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
                .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
                .child(this.copied ? "Copied" : "Copy"))))),
      );
  }
}
