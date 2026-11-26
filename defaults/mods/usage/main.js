// AI token usage and cost across agents, read from the codeburn CLI
// (https://github.com/getagentseal/codeburn), which parses each agent's local sessions.
// Drawn like codeburn's own dashboard: bordered panels, gradient bars, number columns.
// ponytail: one exec per refresh; `codeburn serve` (resident stdio server) if startup cost hurts.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, settings, checking } from "herdr";

const PERIODS = [["today", "Today"], ["week", "7 Days"], ["30days", "30 Days"], ["month", "This Month"], ["all", "6 Months"], ["lifetime", "Lifetime"]];
const REFRESH = 5 * 60 * 1000;
const ORANGE = "#ff8a3d"; // codeburn's brand color; ANSI has no orange
const DAYS = 14;

const money = (n) => { n = n ?? 0; return `$${n >= 1 || n === 0 ? n.toFixed(2) : n.toFixed(3)}`; };
const grouped = (n) => String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const short = (n) => {
  n = n ?? 0;
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
};
const pct = (r) => (r == null ? "–" : `${(r * 100).toFixed(r === 1 ? 0 : 1)}%`);
const cacheHit = (r) => {
  const all = (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
  return all ? (r.cacheReadTokens ?? 0) / all : null;
};
const minutes = (ms) => (ms == null ? "–" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
const byCost = (rows) => [...(rows ?? [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));

export default class Usage extends View {
  init(_props, cx) {
    this.period = "today"; this.data = null; this.error = null;
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
    const font = settings().font_family ?? "JetBrains Mono";
    const COST = t.ansi3, DIM = t.dim;
    // Activity names in codeburn's colors.
    const ACTIVITY = { coding: t.ansi12, feature: t.ansi2, refactoring: t.ansi3, exploration: t.ansi6, debugging: t.ansi1,
      build: t.ansi2, testing: t.ansi5, brainstorming: t.ansi13, conversation: DIM, general: DIM };
    const activityColor = (r) => ACTIVITY[Object.keys(ACTIVITY).find((k) => (r.rawCategory ?? "").startsWith(k))] ?? t.foreground;

    // Ten cells, blue then yellow then orange, filled to the row's share of the panel's largest value.
    const bar = (frac) => {
      const filled = frac > 0 ? Math.max(1, Math.round(frac * 10)) : 0;
      return h_flex().flex_none().w(100).gap(1).children(Array.from({ length: 10 }, (_, i) =>
        div().w(9).h(12).bg(i >= filled ? t.border : i < 4 ? t.ansi4 : i < 7 ? t.ansi3 : ORANGE).opacity(i >= filled ? 0.35 : 1)));
    };
    const cell = (text, width, color) => div().w(width).flex_none().text_right().truncate().text_color(color ?? t.foreground).child(text);
    // rows: { label, color?, value (for the bar), cells: [[text, color?], ...] }; cols: [[header, width], ...]
    const panel = (id, title, color, cols, rows, empty, footer) => {
      const max = Math.max(...rows.map((r) => r.value ?? 0), 0);
      return v_flex().id(id).flex_1().min_w(320).min_h(180).px(12).py(10).gap(2).rounded(4).border_1().border_color(color)
        .child(div().font_bold().text_color(color).pb(4).child(title))
        .when(rows.length > 0 && cols.some(([h]) => h), (e) => e.child(h_flex().gap(8).text_color(DIM)
          .child(div().flex_1()).children(cols.map(([h, w]) => cell(h, w, DIM)))))
        .when(!rows.length, (e) => e.child(div().text_color(DIM).child(empty)))
        .children(rows.map((r, i) => h_flex().id(`${id}-${i}`).gap(8).items_center()
          .when(r.value !== undefined, (e) => e.child(bar(max ? (r.value ?? 0) / max : 0)))
          .child(div().flex_1().min_w(0).truncate().text_color(r.color ?? t.foreground).child(r.label))
          .children(r.cells.map(([text, col], j) => cell(text, cols[j]?.[1] ?? 60, col)))))
        .when(Boolean(footer), (e) => e.child(div().pt(4).text_color(DIM).truncate().child(footer)));
    };
    const row3 = (...children) => h_flex().flex_wrap().gap(10).items_stretch().children(children);

    const header = h_flex().h(36).flex_none().px(14).gap(18).items_center().border_b(1).border_color(t.border)
      .children(PERIODS.map(([p, label]) => {
        const on = p === this.period;
        return div().id(`period-${p}`).cursor_pointer().text_color(on ? ORANGE : DIM).when(on, (e) => e.font_bold())
          .hover((s) => s.text_color(on ? ORANGE : t.foreground))
          .on_click((_e, cx) => this.select(p, cx)).child(on ? `[ ${label} ]` : label);
      }))
      .child(div().flex_1())
      .when(this.loading, (e) => e.child(div().text_color(DIM).child("refreshing…")))
      .child(div().id("refresh").cursor_pointer().text_color(ORANGE).font_bold().hover((s) => s.opacity(0.8))
        .on_click((_e, cx) => { this.refresh(cx); cx.notify(); }).child("[r] Refresh"));

    const body = v_flex().id("usage-body").flex_1().min_h(0).p(12).gap(10).overflow_y_scrollbar();
    if (!c) {
      return this.frame(t, font, header, body.child(div().text_color(this.error ? t.ansi1 : DIM)
        .child(this.error || "Loading… (codeburn reads every agent's sessions, the first run can take a while)")));
    }

    const summary = v_flex().flex_none().px(12).py(8).gap(2).rounded(4).border_1().border_color(ORANGE)
      .child(h_flex().gap(10).child(div().font_bold().text_color(ORANGE).child("CodeBurn")).child(div().text_color(DIM).child(c.label ?? "")))
      .child(h_flex().gap(18)
        .child(h_flex().gap(6).child(div().font_bold().text_color(COST).child(money(c.cost))).child("cost"))
        .child(h_flex().gap(6).child(div().font_bold().child(grouped(c.calls))).child("calls"))
        .child(h_flex().gap(6).child(div().font_bold().child(grouped(c.sessions))).child("sessions"))
        .child(h_flex().gap(6).child(div().font_bold().child(`${(c.cacheHitPercent ?? 0).toFixed(1)}%`)).child("cache hit")))
      .child(h_flex().gap(18).text_color(DIM)
        .child(`${short(c.inputTokens)} in`).child(`${short(c.outputTokens)} out`)
        .child(`${short(c.cacheReadTokens)} cached`).child(`${short(c.cacheWriteTokens)} written`))
      .when(Boolean(this.error), (e) => e.child(div().text_color(t.ansi1).child(this.error)));

    const days = [...(d.history?.daily ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1));
    const daily = panel("daily", "Daily Activity", t.ansi4, [["cost", 70], ["calls", 50]],
      days.slice(0, DAYS).map((r) => ({ label: r.date, color: DIM, value: r.cost, cells: [[money(r.cost), COST], [grouped(r.calls)]] })),
      "No history", days.length ? `Showing 1–${Math.min(DAYS, days.length)} of ${days.length} days · newest first` : null);

    const projects = panel("projects", "By Project", t.ansi2, [["cost", 70], ["avg/s", 60], ["sessions", 64]],
      byCost(c.topProjects).map((r) => ({ label: r.name, color: DIM, value: r.cost,
        cells: [[money(r.cost), COST], [r.sessions ? money(r.avgCostPerSession) : "–", COST], [grouped(r.sessions)]] })),
      "No projects");

    const activities = panel("activities", "By Activity", t.ansi3, [["cost", 70], ["turns", 50], ["1-shot", 54]],
      byCost(c.topActivities).map((r) => ({ label: r.name, color: activityColor(r), value: r.cost,
        cells: [[money(r.cost), COST], [grouped(r.turns)], [pct(r.oneShotRate), r.oneShotRate == null ? DIM : r.oneShotRate >= 0.9 ? t.ansi2 : ORANGE]] })),
      "No activity");

    const oneShot = Object.fromEntries((c.modelEfficiency ?? []).map((m) => [m.name, m.oneShotRate]));
    const models = panel("models", "By Model", t.ansi5, [["cost", 70], ["cache", 56], ["calls", 50], ["1-shot", 54]],
      byCost(c.topModels).map((r) => ({ label: r.name, value: r.cost,
        cells: [[money(r.cost), COST], [pct(cacheHit(r))], [grouped(r.calls)], [pct(oneShot[r.name])]] })),
      "No models");

    const agents = panel("agents", "By Agent", ORANGE, [["cost", 70], ["calls", 50], ["sessions", 64], ["tokens", 60]],
      byCost((c.providerDetails ?? []).filter((p) => p.hasUsage)).map((r) => ({ label: r.label, value: r.cost,
        cells: [[money(r.cost), COST], [grouped(r.calls)], [grouped(r.sessions)],
          [short((r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0))]] })),
      "No agents");

    const tools = panel("tools", "Core Tools", t.ansi6, [["calls", 60]],
      (c.tools ?? []).map((r) => ({ label: r.name, value: r.calls, cells: [[grouped(r.calls)]] })), "No tool calls");

    const mcp = panel("mcp", "MCP Servers", t.ansi13, [["calls", 60]],
      (c.mcpServers ?? []).map((r) => ({ label: r.name, value: r.calls, cells: [[grouped(r.calls)]] })), "No MCP usage");

    const skills = panel("skills", "Skills & Agents", t.ansi12, [["uses", 50], ["cost", 70]],
      byCost([...(c.skills ?? []).map((s) => ({ ...s, uses: s.turns })), ...(c.subagents ?? []).map((s) => ({ ...s, name: `@${s.name}`, uses: s.calls }))])
        .map((r) => ({ label: r.name, value: r.cost, cells: [[grouped(r.uses)], [money(r.cost), COST]] })),
      "No skills or subagents");

    const w = c.workflow ?? {}, rework = c.topReworkedFiles?.[0];
    const workflow = panel("workflow", "Workflow", t.ansi4, [["", 200]], [
      { label: "Corrections", color: DIM, cells: [[`${pct(w.correctionRate ?? 0)} (${w.corrections ?? 0})`]] },
      { label: "First edit", color: DIM, cells: [[minutes(w.medianTimeToFirstEditMs)]] },
      { label: "Rework", color: DIM, cells: [[rework ? `${rework.path.split("/").pop()} ×${rework.edits}` : "–"]] },
    ], "No workflow data");

    return this.frame(t, font, header, body
      .child(summary)
      .child(row3(daily, projects, activities))
      .child(row3(models, agents, tools))
      .child(row3(mcp, skills, workflow)));
  }

  frame(t, font, header, body) {
    return v_flex().id("usage").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).font_family(font).text_size(12.5)
      .child(header).child(body);
  }
}
