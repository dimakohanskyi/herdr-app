import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, window, shared, setShared, checking, layout } from "herdr";

// Pulse: my GitHub PRs, reviews and code volume across every account `gh` is logged into.

const RANGES = [7, 30, 90];
const REFRESH_MS = 5 * 60 * 1000;
const CACHE = "pulse.cache.v1";

const PR_FIELDS = `...on PullRequest{number title url isDraft createdAt updatedAt additions deletions mergeable reviewDecision
  repository{nameWithOwner} author{login} labels(first:10){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`;
const DONE_FIELDS = `...on PullRequest{number title url state createdAt mergedAt closedAt additions deletions repository{nameWithOwner}}`;
const ISSUE_FIELDS = `...on Issue{number title url updatedAt repository{nameWithOwner}}`;

// One search per call: GitHub cuts a GraphQL request off at 10 s, and one big
// query with line counts on 100 PRs gets there.
const SEARCHES = {
  mine: ["is:pr is:open archived:false author:@me", 50, PR_FIELDS],
  assigned: ["is:pr is:open archived:false assignee:@me -author:@me", 50, PR_FIELDS],
  review: ["is:pr is:open archived:false review-requested:@me", 50, PR_FIELDS],
  // ponytail: first 100 closed PRs in 90 days; page with `after:` if that's ever not enough.
  done: [`is:pr author:@me is:closed closed:>=${day(-Math.max(...RANGES))}`, 100, DONE_FIELDS],
  issues: ["is:issue is:open archived:false assignee:@me", 50, ISSUE_FIELDS],
};

function day(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// GH_TOKEN picks the account for this one call without switching gh's active account.
// ponytail: needs `sh`, so macOS and Linux only.
function gh(acc, args) {
  return exec("sh", ["-c", 't="$(gh auth token -h "$1" -u "$2")" || exit 1; shift 2; GH_TOKEN="$t" exec gh "$@"', "sh", acc.host, acc.login, ...args], { timeout: 60000 });
}

async function search(acc, [q, first, fields]) {
  const query = `query($q:String!){search(type:ISSUE,first:${first},query:$q){issueCount nodes{${fields}}}}`;
  const r = await gh(acc, ["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited with ${r.code}`);
  const d = JSON.parse(r.stdout);
  if (d.errors?.length) throw new Error(d.errors[0].message);
  return d.data.search.nodes.filter((n) => n?.url);
}

async function accounts() {
  const r = await exec("gh", ["auth", "status", "--json", "hosts"]);
  const hosts = JSON.parse(r.stdout || "{}").hosts ?? {};
  return Object.values(hosts).flat().filter((a) => a.state === "success").map((a) => ({ login: a.login, host: a.host }));
}

async function load() {
  const list = await accounts();
  if (!list.length) throw new Error("gh is not logged in. Run `gh auth login`.");
  const out = await Promise.all(list.map(async (acc) => {
    try {
      const keys = Object.keys(SEARCHES);
      const res = await Promise.all(keys.map((k) => search(acc, SEARCHES[k])));
      return { ...acc, ...Object.fromEntries(keys.map((k, i) => [k, res[i]])) };
    } catch (e) {
      return { ...acc, error: String(e.message ?? e) };
    }
  }));
  return { accounts: out, at: Date.now() };
}

// "Blocked" is any of: changes requested, failing checks, merge conflicts, a label with "block" in it.
export function blockers(p) {
  const out = [];
  const ci = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (p.reviewDecision === "CHANGES_REQUESTED") out.push("changes requested");
  if (ci === "FAILURE" || ci === "ERROR") out.push("CI failing");
  if (p.mergeable === "CONFLICTING") out.push("conflicts");
  if (p.labels?.nodes?.some((l) => /block/i.test(l.name))) out.push("blocked label");
  return out;
}

export function column(p) {
  if (p.review) return "review";
  if (blockers(p).length) return "blocked";
  if (!p.isDraft && p.reviewDecision === "APPROVED") return "ready";
  return "waiting";
}

function waitingOn(p) {
  const ci = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (p.isDraft) return "draft";
  if (ci === "PENDING" || ci === "EXPECTED") return "CI running";
  return "awaiting review";
}

// Everything the page shows for the chosen accounts and range.
export function summarize(accs, range, now = Date.now()) {
  const cutoff = now - range * 86400000, seen = new Map(), add = (p, extra) => { if (!seen.has(p.url)) seen.set(p.url, { ...p, ...extra }); };
  for (const a of accs) {
    for (const p of a.review ?? []) add(p, { acc: a.login, review: true });
    for (const p of [...(a.mine ?? []), ...(a.assigned ?? [])]) add(p, { acc: a.login });
  }
  const open = [...seen.values()].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
  const done = new Map();
  for (const a of accs) for (const p of a.done ?? []) if (Date.parse(p.closedAt) >= cutoff && !done.has(p.url)) done.set(p.url, { ...p, acc: a.login });
  const closed = [...done.values()].sort((x, y) => Date.parse(y.closedAt) - Date.parse(x.closedAt));
  const merged = closed.filter((p) => p.state === "MERGED");
  const hours = merged.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3600000).sort((x, y) => x - y);
  const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;

  // Bars: days for a week, weeks otherwise, newest last.
  const step = range <= 7 ? 1 : 7, count = Math.ceil(range / step);
  const buckets = Array.from({ length: count }, () => ({ add: 0, del: 0 }));
  for (const p of merged) {
    const i = count - 1 - Math.floor((now - Date.parse(p.mergedAt)) / (step * 86400000));
    if (i >= 0 && i < count) { buckets[i].add += p.additions; buckets[i].del += p.deletions; }
  }

  const repos = new Map(), repo = (name) => repos.get(name) ?? repos.set(name, { name, open: 0, merged: 0, add: 0, del: 0 }).get(name);
  for (const p of open) if (!p.review) repo(p.repository.nameWithOwner).open++;
  for (const p of merged) { const r = repo(p.repository.nameWithOwner); r.merged++; r.add += p.additions; r.del += p.deletions; }

  const issues = new Map();
  for (const a of accs) for (const i of a.issues ?? []) if (!issues.has(i.url)) issues.set(i.url, { ...i, acc: a.login });

  const by = (c) => open.filter((p) => column(p) === c);
  return {
    open, closed, merged, median, buckets, step,
    columns: { review: by("review"), waiting: by("waiting"), blocked: by("blocked"), ready: by("ready") },
    mine: open.filter((p) => !p.review).length,
    add: merged.reduce((s, p) => s + p.additions, 0),
    del: merged.reduce((s, p) => s + p.deletions, 0),
    repos: [...repos.values()].sort((x, y) => (y.add + y.del + y.open * 1000) - (x.add + x.del + x.open * 1000)),
    issues: [...issues.values()].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt)),
  };
}

const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function ago(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
const repoName = (full) => full.split("/")[1] ?? full;
const tint = (c, a) => `${(c ?? "#888888").slice(0, 7)}${a}`;

function openUrl(url) {
  const p = window()?.platform;
  const [cmd, args] = p === "macos" ? ["open", [url]] : p === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => null);
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}

export default class Pulse extends View {
  init(_props, cx) {
    this.sel = "all";
    this.range = 30;
    this.data = null;
    try { this.data = JSON.parse(localStorage.getItem(CACHE) ?? "null"); } catch { this.data = null; }
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.data = await load();
        try { localStorage.setItem(CACHE, JSON.stringify(this.data)); } catch {}
        const s = summarize(this.data.accounts, this.range);
        const attention = s.columns.review.length + s.columns.blocked.length;
        if (shared("pulse.attention") !== attention) setShared("pulse.attention", attention);
      } catch (e) {
        this.error = String(e.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  colors(t) {
    const list = this.data?.accounts ?? [], palette = [t.ansi4, t.ansi2, t.ansi3, t.ansi5, t.ansi6, t.ansi1];
    return Object.fromEntries(list.map((a, i) => [a.login, palette[i % palette.length]]));
  }

  dot(color, size = 8) {
    return div().size(size).flex_none().rounded(size / 2).bg(color);
  }

  pill(text, color) {
    return div().px(6).h(16).flex().items_center().rounded(8).bg(tint(color, "26")).text_color(color).text_size(10.5).font_medium().child(text);
  }

  card(t, title, note, body) {
    return v_flex().min_w(0).border(1).border_color(t.border).rounded(8).bg(t.background)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_color(t.foreground).child(title))
        .when(Boolean(note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(note))))
      .child(body);
  }

  // ---- sidebar ----

  sidebar(t, colors) {
    const w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const accs = this.data?.accounts ?? [];
    const countFor = (list) => { const s = summarize(list, this.range); return s.columns.review.length + s.columns.blocked.length; };
    const row = (id, label, lead, count, error) => {
      const on = this.sel === id;
      return h_flex().id(`acc-${id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .when(Boolean(error), (el) => el.tooltip(error))
        .on_click((_e, cx) => { this.sel = id; cx.notify(); })
        .when(Boolean(lead), (el) => el.child(lead))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .child(error ? div().text_color(t.ansi1).child("!") : count ? div().px(6).rounded(8).bg(t.accent).text_color(t.accent_foreground).text_size(10.5).font_semibold().child(String(count)) : div());
    };
    const label = (text) => div().px(8).pt(14).pb(4).text_size(11).text_color(t.dim).font_medium().child(text);
    return v_flex().w(232).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).text_size(13)
      .child(h_flex().h(46).pl(lights ? 30 : 16).pr(10).items_center().gap(8)
        .child(svg("mods/rail/activity.svg").size(15).text_color(t.accent))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Pulse")))
      .child(v_flex().px(8).gap(1)
        .child(label("ACCOUNTS"))
        .child(row("all", "All accounts", null, accs.length ? countFor(accs.filter((a) => !a.error)) : 0))
        .children(accs.map((a) => row(a.login, a.login, this.dot(colors[a.login]), a.error ? 0 : countFor([a]), a.error)))
        .child(label("RANGE"))
        .child(h_flex().px(4).gap(4).children(RANGES.map((r) => {
          const on = this.range === r;
          return div().id(`range-${r}`).flex_1().h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(12)
            .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border(1).border_color(on ? t.border : t.chrome)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.range = r; cx.notify(); })
            .child(`${r}d`);
        }))))
      .child(div().flex_1())
      .child(h_flex().id("refresh").h(40).px(16).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.refresh(cx))
        .when(Boolean(this.loading), (el) => el.child(svg("mods/pulse/spinner.svg").size(12).spin(900)))
        .child(this.loading ? "Refreshing…" : this.data ? `Synced ${new Date(this.data.at).toTimeString().slice(0, 5)} · Refresh` : "Refresh"));
  }

  // ---- main ----

  kpis(t, s) {
    const tile = (label, value, sub, tone) => v_flex().flex_1().min_w(0).px(12).py(10).gap(2).rounded(8).border(1)
      .border_color(tone ?? t.border).bg(tone ? tint(tone, "14") : t.background)
      .child(div().text_size(11).text_color(t.muted).truncate().child(label))
      .child(div().text_size(22).font_semibold().text_color(t.foreground).child(value))
      .child(div().text_size(11).text_color(t.muted).truncate().child(sub ?? " "));
    const review = s.columns.review, blocked = s.columns.blocked, closedOnly = s.closed.length - s.merged.length;
    return h_flex().gap(10)
      .child(tile("My open PRs", String(s.mine), s.columns.ready.length ? `${s.columns.ready.length} ready to merge` : null))
      .child(tile("Needs my review", String(review.length), review.length ? `oldest ${ago(review.at(-1).createdAt)}` : "all clear", review.length ? t.ansi3 : null))
      .child(tile("Blocked", String(blocked.length), blocked.length ? "act on these first" : "none", blocked.length ? t.ansi1 : null))
      .child(tile(`Merged · ${this.range}d`, String(s.merged.length), closedOnly ? `${closedOnly} closed unmerged` : null))
      .child(tile(`Lines · ${this.range}d`, `+${fmt(s.add)}`, `−${fmt(s.del)} removed`))
      .child(tile("Median time to merge", s.median == null ? "–" : s.median < 48 ? `${Math.round(s.median)}h` : `${Math.round(s.median / 24)}d`, `${s.merged.length} merged PRs`));
  }

  prCard(t, p, col, colors) {
    const why = col === "blocked" ? blockers(p) : [];
    const edge = { review: t.ansi3, blocked: t.ansi1, ready: t.ansi2, waiting: t.border }[col];
    return v_flex().id(`pr-${p.url}`).min_w(0).gap(3).px(8).py(6).rounded(6).border(1).border_color(t.border).border_l(3).border_color(edge)
      .bg(t.background).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${p.repository.nameWithOwner}#${p.number} · open on GitHub`)
      .on_click(() => openUrl(p.url))
      .child(div().text_size(12.5).font_medium().text_color(t.foreground).truncate().child(p.title))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted).min_w(0)
        .when(this.sel === "all", (el) => el.child(this.dot(colors[p.acc], 7)))
        .child(div().truncate().child(`${repoName(p.repository.nameWithOwner)} #${p.number}`))
        .child(div().text_color(t.ansi2).child(`+${fmt(p.additions)}`))
        .child(div().text_color(t.ansi1).child(`−${fmt(p.deletions)}`))
        .child(div().text_color(t.dim).child(ago(p.updatedAt))))
      .when(why.length > 0, (el) => el.child(h_flex().gap(4).children(why.map((w) => this.pill(w, t.ansi1)))))
      .when(col === "ready", (el) => el.child(h_flex().child(this.pill("approved", t.ansi2))))
      .when(col === "waiting", (el) => el.child(h_flex().child(this.pill(waitingOn(p), t.muted))))
      .when(col === "review", (el) => el.child(h_flex().child(this.pill(`by ${p.author?.login ?? "?"}`, t.ansi3))));
  }

  board(t, s, colors) {
    const cols = [["review", "Needs my review"], ["waiting", "Waiting on others"], ["blocked", "Blocked"], ["ready", "Ready to merge"]];
    return this.card(t, "PR board", `${s.open.length} open`, h_flex().items_start().children(cols.map(([c, label], i) =>
      v_flex().flex_1().min_w(0).p(8).gap(6).when(i < cols.length - 1, (el) => el.border_r(1).border_color(t.border))
        .child(h_flex().gap(6).items_center().text_size(12).child(div().font_semibold().text_color(t.foreground).child(label))
          .child(div().text_color(t.muted).child(String(s.columns[c].length))))
        .children(s.columns[c].length ? s.columns[c].map((p) => this.prCard(t, p, c, colors)) : [div().text_size(11.5).text_color(t.dim).child("Nothing here")]))));
  }

  chart(t, s) {
    const UP = 90, DOWN = 40;
    const maxAdd = Math.max(1, ...s.buckets.map((b) => b.add)), maxDel = Math.max(1, ...s.buckets.map((b) => b.del));
    // One scale for both halves, so a removed line is as tall as an added one.
    const scale = Math.max(maxAdd / UP, maxDel / DOWN);
    const n = s.buckets.length;
    const label = (i) => (i === n - 1 ? (s.step === 1 ? "today" : "this wk") : s.step === 1 ? `${n - 1 - i}d` : `${n - 1 - i}w`);
    return this.card(t, "Lines changed", `merged PRs, per ${s.step === 1 ? "day" : "week"}`, v_flex().p(12).gap(4)
      .child(h_flex().gap(4).items_end().children(s.buckets.map((b, i) => v_flex().flex_1().min_w(0).items_center()
        .tooltip(`+${b.add} / −${b.del}`)
        .id(`bar-${i}`)
        .child(v_flex().h(UP).w_full().justify_end().items_center().child(div().w_full().max_w(28).h(Math.max(b.add ? 2 : 0, b.add / scale)).rounded(2).bg(t.ansi2)))
        .child(div().h(1).w_full().bg(t.border))
        .child(v_flex().h(DOWN).w_full().items_center().child(div().w_full().max_w(28).h(Math.max(b.del ? 2 : 0, b.del / scale)).rounded(2).bg(t.ansi1)))
        .child(div().pt(4).text_size(10).text_color(t.dim).child(n <= 8 || i % 2 === (n - 1) % 2 ? label(i) : " ")))))
      .child(h_flex().gap(12).pt(4).text_size(11).text_color(t.muted)
        .child(h_flex().gap(4).items_center().child(this.dot(t.ansi2)).child(`+${fmt(s.add)} added`))
        .child(h_flex().gap(4).items_center().child(this.dot(t.ansi1)).child(`−${fmt(s.del)} removed`))));
  }

  table(t, head, rows, widths) {
    const cell = (text, i, color) => div().w(widths[i] ?? 60).when(i === 0, (el) => el.flex_1().w(0)).min_w(0).truncate().text_color(color ?? t.foreground).child(text);
    return v_flex().text_size(12)
      .child(h_flex().h(28).px(12).gap(8).items_center().border_b(1).border_color(t.border).children(head.map((h, i) => cell(h, i, t.muted))))
      .children(rows.length ? rows.map((r, j) => h_flex().id(`row-${j}-${head[0]}`).h(30).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(r.url), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => openUrl(r.url)))
        .children(r.cells.map((c, i) => (typeof c === "string" ? cell(c, i) : div().w(widths[i] ?? 60).when(i === 0, (el) => el.flex_1().w(0)).min_w(0).child(c)))))
        : [div().px(12).py(10).text_size(11.5).text_color(t.dim).child("Nothing here")]);
  }

  repos(t, s, colors) {
    return this.card(t, "Repos", null, this.table(t, ["Repo", "Open", "Merged", "+/−"],
      s.repos.slice(0, 12).map((r) => ({ cells: [r.name, String(r.open), String(r.merged),
        h_flex().gap(4).child(div().text_color(t.ansi2).child(`+${fmt(r.add)}`)).child(div().text_color(t.ansi1).child(`−${fmt(r.del)}`))] })),
      [0, 44, 56, 90]));
  }

  closed(t, s, colors) {
    return this.card(t, "Closed PRs", `last ${this.range} days`, this.table(t, ["PR", "Repo", "State", "When"],
      s.closed.slice(0, 15).map((p) => ({ url: p.url, cells: [p.title, repoName(p.repository.nameWithOwner),
        this.pill(p.state === "MERGED" ? "merged" : "closed", p.state === "MERGED" ? t.ansi5 : t.muted), ago(p.closedAt)] })),
      [0, 120, 64, 44]));
  }

  issues(t, s, colors) {
    return this.card(t, "Issues assigned to me", `${s.issues.length} open`, this.table(t, ["Issue", "Repo", "Updated"],
      s.issues.slice(0, 15).map((i) => ({ url: i.url, cells: [
        h_flex().gap(6).items_center().min_w(0).when(this.sel === "all", (el) => el.child(this.dot(colors[i.acc], 7))).child(div().min_w(0).truncate().child(i.title)),
        repoName(i.repository.nameWithOwner), ago(i.updatedAt)] })),
      [0, 120, 56]));
  }

  message(t, title, body) {
    return v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.muted)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12.5).child(body));
  }

  render() {
    const t = theme(), colors = this.colors(t);
    const all = this.data?.accounts ?? [];
    const accs = (this.sel === "all" ? all : all.filter((a) => a.login === this.sel)).filter((a) => !a.error);
    let body;
    if (!this.data) body = this.error ? this.message(t, "Can't reach GitHub", this.error) : this.message(t, "Loading your PRs…", "Asking gh for every logged-in account");
    else {
      const s = summarize(accs, this.range);
      const failed = all.filter((a) => a.error && (this.sel === "all" || a.login === this.sel));
      body = v_flex().id("pulse-scroll").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(16).gap(16)
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(18).font_semibold().text_color(t.foreground).child(this.sel === "all" ? "All accounts" : this.sel))
          .child(div().text_size(12).text_color(t.muted).child(`last ${this.range} days`)))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(`Refresh failed: ${this.error}`)))
        .children(failed.map((a) => div().text_size(12).text_color(t.ansi1).child(`${a.login}: ${a.error}`)))
        .child(this.kpis(t, s))
        .child(this.board(t, s, colors))
        .child(h_flex().gap(16).items_start()
          .child(div().flex_1().min_w(0).child(this.chart(t, s)))
          .child(div().flex_1().min_w(0).child(this.repos(t, s, colors))))
        .child(h_flex().gap(16).items_start()
          .child(div().flex_1().min_w(0).child(this.closed(t, s, colors)))
          .child(div().flex_1().min_w(0).child(this.issues(t, s, colors))));
    }
    // The rail's sidebar button (and cmd-b) hides this screen's sidebar too.
    const hidden = Boolean(findNode(layout(), "sidebar")?.hidden), w = window();
    return h_flex().size_full().bg(t.canvas ?? t.background).text_color(t.foreground)
      // Without the sidebar, keep the page clear of the macOS window buttons.
      .when(hidden && w?.platform === "macos" && !w?.fullscreen, (el) => el.pt(28))
      .when(!hidden, (el) => el.child(this.sidebar(t, colors)))
      .child(body);
  }
}
