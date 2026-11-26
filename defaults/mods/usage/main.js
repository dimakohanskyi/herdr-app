// AI token usage and cost across agents, read from the codeburn CLI
// (https://github.com/getagentseal/codeburn), which parses each agent's local sessions.
// ponytail: one exec per refresh; `codeburn serve` (resident stdio server) if startup cost hurts.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, checking } from "herdr";

const PERIODS = [["today", "Today"], ["week", "7 days"], ["30days", "30 days"], ["month", "Month"]];
const REFRESH = 5 * 60 * 1000;

const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const count = (n) => {
  n = n ?? 0;
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
};
const tokens = (r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);

export default class Usage extends View {
  init(_props, cx) {
    this.period = "week"; this.data = null; this.error = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    const period = this.period;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("codeburn", ["status", "--format", "menubar-json", "--period", period], { timeout: 120000 });
        if (period !== this.period) return;
        if (r.code !== 0) { this.error = r.stderr.trim() || `codeburn exited with ${r.code}`; return; }
        this.data = JSON.parse(r.stdout); this.error = null;
      } catch (e) {
        this.error = /not found|no such file|cannot start|ENOENT/i.test(String(e))
          ? "codeburn is not installed: npm i -g codeburn" : String(e);
      } finally { this.loading = false; cx.notify(); }
    });
  }

  select(period, cx) {
    if (period === this.period) return;
    this.period = period; this.data = null; this.loading = false;
    this.refresh(cx);
    cx.notify();
  }

  render(cx) {
    const t = theme(), d = this.data, c = d?.current;
    const chip = (id, label, on, action) => div().id(id).h(24).px(9).flex().flex_none().items_center().rounded(6).text_size(11.5)
      .cursor_pointer().bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click(action).child(label);
    const tile = (label, value, sub) => v_flex().flex_1().min_w(120).p(12).gap(2).rounded(8).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(div().text_size(20).font_semibold().child(value))
      .when(Boolean(sub), (e) => e.child(div().text_size(11).text_color(t.dim).child(sub)));
    // Rows sorted by cost; the bar is the row's share of the section's largest cost.
    const section = (id, title, rows) => {
      const max = Math.max(...rows.map((r) => r.cost ?? 0), 0.0001);
      return v_flex().id(id).flex_1().min_w(260).p(12).gap(8).rounded(8).border_1().border_color(t.border)
        .child(div().font_semibold().child(title))
        .when(!rows.length, (e) => e.child(div().text_color(t.dim).child("Nothing in this period")))
        .children(rows.map((r, i) => v_flex().id(`${id}-${i}`).gap(3)
          .child(h_flex().gap(8)
            .child(div().flex_1().min_w(0).truncate().child(r.name))
            .child(div().text_size(11).text_color(t.dim).child(`${count(tokens(r))} tok`))
            .child(div().w(64).flex_none().text_right().child(money(r.cost))))
          .child(div().h(4).w_full().rounded(2).bg(t.border)
            .child(div().h_full().rounded(2).bg(t.accent).w(`${Math.round(((r.cost ?? 0) / max) * 100)}%`)))));
    };
    const byCost = (rows) => [...(rows ?? [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    const agents = byCost(d?.providerDetails?.filter((p) => p.hasUsage).map((p) => ({ ...p, name: p.label })));

    return v_flex().id("usage").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Usage"))
        .child(div().flex_1())
        .when(this.loading, (e) => e.child(div().text_size(11).text_color(t.dim).child("Refreshing…")))
        .children(PERIODS.map(([p, label]) => chip(`period-${p}`, label, p === this.period, (_e, cx) => this.select(p, cx))))
        .child(chip("refresh", "Refresh", false, (_e, cx) => { this.refresh(cx); cx.notify(); })))
      .child(v_flex().id("usage-body").flex_1().min_h(0).p(14).gap(12).overflow_y_scrollbar()
        .when(Boolean(this.error), (e) => e.child(div().text_color(t.ansi1).child(this.error)))
        .when(!c && !this.error, (e) => e.child(div().text_color(t.dim).child("Loading… (codeburn reads every agent's sessions, the first run can take a while)")))
        .when(Boolean(c), (e) => e
          .child(h_flex().flex_wrap().gap(10)
            .child(tile("Cost", money(c.cost), c.label))
            .child(tile("Tokens", count(tokens(c)), `${count(c.inputTokens)} in · ${count(c.outputTokens)} out`))
            .child(tile("Cache", `${Math.round(c.cacheHitPercent ?? 0)}%`, `${count(c.cacheReadTokens)} read · ${count(c.cacheWriteTokens)} written`))
            .child(tile("Calls", count(c.calls), `${c.sessions ?? 0} sessions`)))
          .child(h_flex().flex_wrap().gap(10).items_start()
            .child(section("agents", "By agent", agents))
            .child(section("models", "By model", byCost(c.topModels))))
          .child(h_flex().flex_wrap().gap(10).items_start()
            .child(section("projects", "By project", byCost(c.topProjects)))
            .child(section("activities", "By activity", byCost(c.topActivities))))));
  }
}
