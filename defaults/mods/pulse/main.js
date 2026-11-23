import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, window, shared, setShared, checking } from "herdr";

// Pulse: my GitHub PRs, reviews and code volume across every account `gh` is logged into.

const RANGES = [7, 30, 90];
const REFRESH_MS = 5 * 60 * 1000;
const CACHE = "pulse.cache.v2";
// Which repos count: organisations' (default), my own accounts', or both.
const SCOPES = [["org", "Orgs"], ["personal", "Personal"], ["all", "All"]];

const PR_FIELDS = `...on PullRequest{number title url isDraft createdAt updatedAt additions deletions mergeable reviewDecision
  repository{nameWithOwner} author{login} labels(first:10){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`;
const DONE_FIELDS = `...on PullRequest{number title url state createdAt mergedAt closedAt additions deletions repository{nameWithOwner}}`;
const ISSUE_FIELDS = `...on Issue{number title url updatedAt repository{nameWithOwner}}`;

// One search per call: GitHub cuts a GraphQL request off at 10 s, and one big
// query with line counts on 100 PRs gets there. [query, page size, fields, pages]
// ponytail: up to 3 pages (300) per search; past that the oldest days undercount.
function searches() {
  const since = day(-Math.max(...RANGES));
  return {
    mine: ["is:pr is:open archived:false author:@me", 50, PR_FIELDS],
    assigned: ["is:pr is:open archived:false assignee:@me -author:@me", 50, PR_FIELDS],
    review: ["is:pr is:open archived:false review-requested:@me", 50, PR_FIELDS],
    done: [`is:pr author:@me is:closed closed:>=${since}`, 100, DONE_FIELDS, 3],
    issues: ["is:issue is:open archived:false assignee:@me", 50, ISSUE_FIELDS],
    opened: [`is:pr author:@me created:>=${since}`, 100, "...on PullRequest{url createdAt repository{nameWithOwner}}", 3],
    reviewed: [`is:pr reviewed-by:@me -author:@me updated:>=${since}`, 50,
      "...on PullRequest{url repository{nameWithOwner} reviews(last:30){nodes{author{login} submittedAt}}}", 3],
  };
}

// What counts as a day's activity, in stacking order.
export const TYPES = [
  ["commits", "Commits"], ["opened", "PRs opened"], ["merged", "PRs merged"], ["reviews", "Reviews"],
  ["runs", "Workflow runs"], ["comments", "Comments"], ["other", "Branches & releases"],
];
const COMMENT_EVENTS = ["IssueCommentEvent", "PullRequestReviewCommentEvent", "CommitCommentEvent"];
const OTHER_EVENTS = ["CreateEvent", "ReleaseEvent", "IssuesEvent"];

function day(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// GH_TOKEN picks the account for this one call without switching gh's active account.
// ponytail: needs `sh`, so macOS and Linux only.
function gh(acc, args) {
  return exec("sh", ["-c", 't="$(gh auth token -h "$1" -u "$2")" || exit 1; shift 2; GH_TOKEN="$t" exec gh "$@"', "sh", acc.host, acc.login, ...args], { timeout: 60000 });
}

async function search(acc, [q, first, fields, pages = 1]) {
  const query = `query($q:String!,$after:String){search(type:ISSUE,first:${first},query:$q,after:$after){pageInfo{hasNextPage endCursor} nodes{${fields}}}}`;
  let out = [], after = null;
  for (let page = 0; page < pages; page++) {
    const r = await gh(acc, ["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`, ...(after ? ["-f", `after=${after}`] : [])]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited with ${r.code}`);
    const d = JSON.parse(r.stdout);
    if (d.errors?.length) throw new Error(d.errors[0].message);
    out = out.concat(d.data.search.nodes.filter((n) => n?.url));
    if (!d.data.search.pageInfo.hasNextPage) break;
    after = d.data.search.pageInfo.endCursor;
  }
  return out;
}

// A REST list, every page, one JSON object per line from --jq.
async function rest(acc, path, jq) {
  const r = await gh(acc, ["api", "--paginate", path, "--jq", jq]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh exited with ${r.code}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
      const all = searches(), keys = Object.keys(all), since = day(-Math.max(...RANGES));
      // Activity sources a missing scope or permission can fail: say so, keep the rest.
      const warnings = [];
      const soft = (what, p) => p.catch((e) => { warnings.push(`${what}: ${String(e.message ?? e).split("\n")[0]}`); return []; });
      const [res, commits, feed] = await Promise.all([
        Promise.all(keys.map((k) => search(acc, all[k]))),
        // GitHub's commit search only covers default branches: a branch's commits count once merged.
        soft("commits", rest(acc, `search/commits?q=${encodeURIComponent(`author:${acc.login} committer-date:>=${since}`)}&per_page=100`,
          ".items[] | {at: .commit.author.date, repo: .repository.full_name}")),
        // GitHub keeps only the last 300 events: comments and branches before that are gone.
        soft("events", rest(acc, `users/${acc.login}/events?per_page=100`, ".[] | {type, at: .created_at, repo: .repo.name}")),
      ]);
      const a = { ...acc, ...Object.fromEntries(keys.map((k, i) => [k, res[i]])), commits, feed, warnings };
      // Workflow runs are per repo: ask the repos I'm most active in.
      // ponytail: top 15 repos; runs elsewhere aren't counted.
      const weight = new Map(), bump = (r) => weight.set(r, (weight.get(r) ?? 0) + 1);
      for (const p of [...a.opened, ...a.done, ...a.mine]) bump(p.repository.nameWithOwner);
      for (const c of commits) bump(c.repo);
      const top = [...weight].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([r]) => r);
      // A repo without Actions (or without access to them) has no runs to count.
      a.runs = (await Promise.all(top.map((repo) => rest(acc, `repos/${repo}/actions/runs?actor=${acc.login}&created=>=${since}&per_page=100`,
        `.workflow_runs[] | {at: .created_at, event, repo: "${repo}"}`).catch(() => [])))).flat();
      return a;
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
// scope: "org" (repos my accounts don't own), "personal" (repos they own) or "all".
// owners: every logged-in account, so a repo of another of my accounts is still personal.
export function summarize(accs, range, now = Date.now(), scope = "all", owners = accs.map((a) => a.login)) {
  const mine = new Set(owners.map((o) => o.toLowerCase()));
  const inScope = (repo) => scope === "all" || mine.has(repo.split("/")[0].toLowerCase()) === (scope === "personal");
  const cutoff = now - range * 86400000, seen = new Map(), add = (p, extra) => {
    if (!seen.has(p.url) && inScope(p.repository.nameWithOwner)) seen.set(p.url, { ...p, ...extra });
  };
  for (const a of accs) {
    for (const p of a.review ?? []) add(p, { acc: a.login, review: true });
    for (const p of a.mine ?? []) add(p, { acc: a.login, own: true });
    for (const p of a.assigned ?? []) add(p, { acc: a.login });
  }
  const open = [...seen.values()].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
  const done = new Map();
  for (const a of accs) for (const p of a.done ?? []) if (Date.parse(p.closedAt) >= cutoff && !done.has(p.url) && inScope(p.repository.nameWithOwner)) done.set(p.url, { ...p, acc: a.login });
  const closed = [...done.values()].sort((x, y) => Date.parse(y.closedAt) - Date.parse(x.closedAt));
  const merged = closed.filter((p) => p.state === "MERGED");
  const hours = merged.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3600000).sort((x, y) => x - y);
  const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;

  // Bars: days for a week, weeks otherwise, newest last.
  const step = range <= 7 ? 1 : 7, count = Math.ceil(range / step);
  const buckets = Array.from({ length: count }, () => ({ add: 0, del: 0, oadd: 0, odel: 0 }));
  const bucket = (iso) => { const i = count - 1 - Math.floor((now - Date.parse(iso)) / (step * 86400000)); return i >= 0 && i < count ? buckets[i] : null; };
  for (const p of merged) { const b = bucket(p.mergedAt); if (b) { b.add += p.additions; b.del += p.deletions; } }
  // My open PRs count from the day they were opened.
  const writing = open.filter((p) => p.own && Date.parse(p.createdAt) >= cutoff);
  for (const p of writing) { const b = bucket(p.createdAt); if (b) { b.oadd += p.additions; b.odel += p.deletions; } }

  const repos = new Map(), repo = (name) => repos.get(name) ?? repos.set(name, { name, open: 0, merged: 0, add: 0, del: 0 }).get(name);
  for (const p of open) if (!p.review) repo(p.repository.nameWithOwner).open++;
  for (const p of merged) { const r = repo(p.repository.nameWithOwner); r.merged++; r.add += p.additions; r.del += p.deletions; }
  for (const p of writing) { const r = repo(p.repository.nameWithOwner); r.add += p.additions; r.del += p.deletions; }

  const issues = new Map();
  for (const a of accs) for (const i of a.issues ?? []) if (!issues.has(i.url) && inScope(i.repository.nameWithOwner)) issues.set(i.url, { ...i, acc: a.login });

  // Activity per local calendar day, oldest first.
  const key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const days = Array.from({ length: range }, (_, i) => {
    const at = now - (range - 1 - i) * 86400000;
    return { key: key(at), at, total: 0, ...Object.fromEntries(TYPES.map(([k]) => [k, 0])) };
  });
  const byKey = new Map(days.map((d) => [d.key, d]));
  const count1 = (type, at, repo) => { const d = repo && inScope(repo) && byKey.get(key(Date.parse(at))); if (d) { d[type]++; d.total++; } };
  let feedSince = null;
  for (const a of accs) {
    for (const c of a.commits ?? []) count1("commits", c.at, c.repo);
    for (const p of a.opened ?? []) count1("opened", p.createdAt, p.repository.nameWithOwner);
    for (const p of a.reviewed ?? []) for (const r of p.reviews?.nodes ?? []) if (r.author?.login === a.login && r.submittedAt) count1("reviews", r.submittedAt, p.repository.nameWithOwner);
    for (const r of a.runs ?? []) count1("runs", r.at, r.repo);
    // Pushes, PRs and reviews in the feed are counted above from complete sources.
    for (const e of a.feed ?? []) {
      const type = COMMENT_EVENTS.includes(e.type) ? "comments" : OTHER_EVENTS.includes(e.type) ? "other" : null;
      if (type) count1(type, e.at, e.repo);
    }
    // A full feed (300) means older events were cut off: comments before this are missing.
    if ((a.feed?.length ?? 0) >= 300) { const oldest = Math.min(...a.feed.map((e) => Date.parse(e.at))); feedSince = Math.max(feedSince ?? 0, oldest); }
  }
  for (const p of merged) count1("merged", p.mergedAt, p.repository.nameWithOwner);
  const active = days.filter((d) => d.total > 0), total = days.reduce((n, d) => n + d.total, 0);
  const busiest = days.reduce((b, d) => (d.total > (b?.total ?? 0) ? d : b), null);
  const totals = Object.fromEntries(TYPES.map(([k]) => [k, days.reduce((n, d) => n + d[k], 0)]));

  const by = (c) => open.filter((p) => column(p) === c);
  return {
    open, closed, merged, median, buckets, step,
    columns: { review: by("review"), waiting: by("waiting"), blocked: by("blocked"), ready: by("ready") },
    mine: open.filter((p) => !p.review).length,
    add: merged.reduce((s, p) => s + p.additions, 0),
    del: merged.reduce((s, p) => s + p.deletions, 0),
    oadd: writing.reduce((s, p) => s + p.additions, 0),
    odel: writing.reduce((s, p) => s + p.deletions, 0),
    activity: { days, total, active: active.length, busiest, totals, feedSince: feedSince && feedSince > cutoff ? feedSince : null },
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

export default class Pulse extends View {
  init(_props, cx) {
    this.sel = "all";
    this.range = 30;
    try { this.scope = localStorage.getItem("pulse.scope") ?? "org"; } catch { this.scope = "org"; }
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
        const s = this.summary(this.data.accounts);
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

  summary(accs) {
    return summarize(accs, this.range, Date.now(), this.scope, (this.data?.accounts ?? []).map((a) => a.login));
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
    const countFor = (list) => { const s = this.summary(list); return s.columns.review.length + s.columns.blocked.length; };
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
    const seg = (id, items, current, set) => h_flex().px(4).gap(4).children(items.map(([v, text]) => {
      const on = current === v;
      return div().id(`${id}-${v}`).flex_1().h(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border(1).border_color(on ? t.border : t.chrome)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { set(v); cx.notify(); })
        .child(text);
    }));
    return v_flex().w(232).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).text_size(13)
      .child(h_flex().h(46).pl(lights ? 30 : 16).pr(10).items_center().gap(8)
        .child(svg("mods/rail/activity.svg").size(15).text_color(t.accent))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Pulse")))
      .child(v_flex().px(8).gap(1)
        .child(label("ACCOUNTS"))
        .child(row("all", "All accounts", null, accs.length ? countFor(accs.filter((a) => !a.error)) : 0))
        .children(accs.map((a) => row(a.login, a.login, this.dot(colors[a.login]), a.error ? 0 : countFor([a]), a.error)))
        .child(label("REPOS"))
        .child(seg("scope", SCOPES, this.scope, (v) => { this.scope = v; try { localStorage.setItem("pulse.scope", v); } catch {} }))
        .child(label("RANGE"))
        .child(seg("range", RANGES.map((r) => [r, `${r}d`]), this.range, (v) => { this.range = v; })))
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
      .child(tile(`Lines · ${this.range}d`, `+${fmt(s.add + s.oadd)}`, `−${fmt(s.del + s.odel)} · +${fmt(s.oadd)} in open PRs`))
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
    const maxAdd = Math.max(1, ...s.buckets.map((b) => b.add + b.oadd)), maxDel = Math.max(1, ...s.buckets.map((b) => b.del + b.odel));
    // One scale for both halves, so a removed line is as tall as an added one.
    const scale = Math.max(maxAdd / UP, maxDel / DOWN);
    const n = s.buckets.length;
    const label = (i) => (i === n - 1 ? (s.step === 1 ? "today" : "this wk") : s.step === 1 ? `${n - 1 - i}d` : `${n - 1 - i}w`);
    // Merged solid, open PRs faded on top (added) and below (removed).
    const bar = (n, color) => div().w_full().max_w(28).h(Math.max(n ? 2 : 0, n / scale)).bg(color);
    return this.card(t, "Lines changed", `merged and open PRs, per ${s.step === 1 ? "day" : "week"}`, v_flex().p(12).gap(4)
      .child(h_flex().gap(4).items_end().children(s.buckets.map((b, i) => v_flex().flex_1().min_w(0).items_center()
        .tooltip(`merged +${b.add} / −${b.del} · open +${b.oadd} / −${b.odel}`)
        .id(`bar-${i}`)
        .child(v_flex().h(UP).w_full().justify_end().items_center().child(bar(b.oadd, tint(t.ansi2, "66"))).child(bar(b.add, t.ansi2)))
        .child(div().h(1).w_full().bg(t.border))
        .child(v_flex().h(DOWN).w_full().items_center().child(bar(b.del, t.ansi1)).child(bar(b.odel, tint(t.ansi1, "66"))))
        .child(div().pt(4).text_size(10).text_color(t.dim).child(n <= 8 || i % 2 === (n - 1) % 2 ? label(i) : " ")))))
      .child(h_flex().gap(12).pt(4).text_size(11).text_color(t.muted)
        .child(h_flex().gap(4).items_center().child(this.dot(t.ansi2)).child(`+${fmt(s.add)} merged`))
        .child(h_flex().gap(4).items_center().child(this.dot(tint(t.ansi2, "66"))).child(`+${fmt(s.oadd)} open`))
        .child(h_flex().gap(4).items_center().child(this.dot(t.ansi1)).child(`−${fmt(s.del + s.odel)} removed`))));
  }

  activity(t, s) {
    const A = s.activity, H = 110, max = Math.max(1, ...A.days.map((d) => d.total)), n = A.days.length;
    const color = { commits: t.ansi2, opened: t.ansi4, merged: t.ansi5, reviews: t.ansi3, runs: t.ansi6, comments: t.ansi12 ?? t.ansi4, other: t.dim };
    const short = (d) => d.key.slice(5).replace("-", "/");
    const every = Math.ceil(n / 8);
    const note = A.total ? `${A.total} events · ${(A.total / Math.max(1, A.active)).toFixed(1)} per active day · ${A.active} of ${n} days active` : "nothing yet";
    return this.card(t, "Activity", note, v_flex().p(12).gap(6)
      .child(h_flex().h(H).gap(n > 30 ? 1 : 3).items_end().children(A.days.map((d, i) => v_flex().id(`day-${i}`).flex_1().min_w(0).h_full().justify_end()
        .tooltip(`${d.key}: ${d.total ? TYPES.filter(([k]) => d[k]).map(([k, label]) => `${d[k]} ${label.toLowerCase()}`).join(", ") : "nothing"}`)
        .children(TYPES.filter(([k]) => d[k]).map(([k]) => div().w_full().h(Math.max(2, (d[k] / max) * H)).bg(color[k]))))))
      .child(h_flex().gap(n > 30 ? 1 : 3).text_size(10).text_color(t.dim).children(A.days.map((d, i) =>
        div().flex_1().min_w(0).child((n - 1 - i) % every === 0 ? (i === n - 1 ? "today" : short(d)) : ""))))
      .child(h_flex().flex_wrap().gap_x(14).gap_y(4).pt(2).text_size(11).text_color(t.muted)
        .children(TYPES.map(([k, label]) => h_flex().gap(4).items_center().child(this.dot(color[k])).child(`${label} ${A.totals[k]}`)))
        .when(Boolean(A.busiest), (el) => el.child(div().text_color(t.dim).child(`busiest ${A.busiest.key} (${A.busiest.total})`))))
      .child(div().text_size(10.5).text_color(t.dim).child(
        `Commits count on default branches. Workflow runs you triggered in your 15 most active repos.${A.feedSince ? ` Comments and branches since ${new Date(A.feedSince).toDateString().slice(4, 10)}: GitHub keeps only your last 300 events.` : ""}`)));
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
      const s = this.summary(accs);
      const failed = all.filter((a) => a.error && (this.sel === "all" || a.login === this.sel));
      body = v_flex().id("pulse-scroll").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(16).gap(16)
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(18).font_semibold().text_color(t.foreground).child(this.sel === "all" ? "All accounts" : this.sel))
          .child(div().text_size(12).text_color(t.muted).child(`${{ org: "organisation repos", personal: "personal repos", all: "all repos" }[this.scope]} · last ${this.range} days`)))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(`Refresh failed: ${this.error}`)))
        .children(failed.map((a) => div().text_size(12).text_color(t.ansi1).child(`${a.login}: ${a.error}`)))
        .children(accs.flatMap((a) => (a.warnings ?? []).map((w) => div().text_size(11.5).text_color(t.muted).child(`${a.login} · couldn't count ${w}`))))
        .child(this.kpis(t, s))
        .child(this.activity(t, s))
        .child(this.board(t, s, colors))
        .child(h_flex().gap(16).items_start()
          .child(div().flex_1().min_w(0).child(this.chart(t, s)))
          .child(div().flex_1().min_w(0).child(this.repos(t, s, colors))))
        .child(h_flex().gap(16).items_start()
          .child(div().flex_1().min_w(0).child(this.closed(t, s, colors)))
          .child(div().flex_1().min_w(0).child(this.issues(t, s, colors))));
    }
    return h_flex().size_full().bg(t.canvas ?? t.background).text_color(t.foreground)
      .child(this.sidebar(t, colors))
      .child(body);
  }
}
