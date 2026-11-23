import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, theme, window, spaces, run, openOverlay, shared, setShared, checking } from "herdr";

// Jira: my tickets from Jira Cloud as a Kanban board, linked to GitHub PRs and Herdr spaces.
// Setup is one Keychain item (the token), holding the email as account and the site as comment:
//   security add-generic-password -s herdr-jira -a you@example.com -j yoursite.atlassian.net -w

const SERVICE = "herdr-jira";
const COLUMNS = ["To Do", "In Progress", "In Review", "Stage QA", "Done"];
const DONE_DAYS = 14;
const REFRESH_MS = 5 * 60 * 1000;
const CACHE = "jira.cache.v1";
const SETUP = `security add-generic-password -s ${SERVICE} -a you@example.com -j yoursite.atlassian.net -w`;

// ponytail: one Jira site (the first Keychain item); a list of items when a second site appears.
async function credentials() {
  const meta = await exec("security", ["find-generic-password", "-s", SERVICE]);
  if (meta.code !== 0) return null;
  const attr = (name) => meta.stdout.match(new RegExp(`"${name}"<blob>="([^"]*)"`))?.[1] ?? "";
  const email = attr("acct"), site = attr("icmt").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!email || !site) throw new Error(`The Keychain item "${SERVICE}" needs your email as account (-a) and your site as comment (-j).`);
  const pw = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", email, "-w"]);
  if (pw.code !== 0) throw new Error("Herdr couldn't read the Jira token from Keychain.");
  return { email, site, token: pw.stdout.trim() };
}

// No btoa in mods: Basic auth needs base64 of ASCII "email:token".
export function base64(s) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const [a, b, c] = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < s.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < s.length ? abc[n & 63] : "=");
  }
  return out;
}

async function api(cred, method, path, body) {
  const r = await fetch(`https://${cred.site}${path}`, {
    method,
    headers: { Authorization: `Basic ${base64(`${cred.email}:${cred.token}`)}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join(" ") || msg; } catch {}
    throw new Error(r.status === 401 ? "Jira refused the token (401). Make a classic API token (not \"with scopes\") at id.atlassian.com and save it to Keychain again." : `Jira ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

async function loadIssues(cred) {
  const jql = `assignee = currentUser() AND (statusCategory != Done OR resolved >= -${DONE_DAYS}d) ORDER BY updated DESC`;
  const fields = ["summary", "status", "issuetype", "project", "updated", "resolutiondate"];
  // Search answers a rejected token as an anonymous visitor (200, no tickets): ask who we are first.
  await api(cred, "GET", "/rest/api/3/myself");
  let issues = [], next;
  // ponytail: up to 300 tickets; raise the page count if that's ever not enough.
  for (let page = 0; page < 3; page++) {
    const d = await api(cred, "POST", "/rest/api/3/search/jql", { jql, fields, maxResults: 100, ...(next ? { nextPageToken: next } : {}) });
    issues = issues.concat(d.issues ?? []);
    next = d.nextPageToken;
    if (!next) break;
  }
  return issues.map((i) => ({
    key: i.key,
    title: i.fields.summary ?? "",
    status: i.fields.status?.name ?? "",
    category: i.fields.status?.statusCategory?.key ?? "",
    type: i.fields.issuetype?.name ?? "",
    project: i.fields.project?.key ?? i.key.split("-")[0],
    projectName: i.fields.project?.name ?? "",
    updated: i.fields.updated,
  }));
}

// A ticket's column: its status by name, else by Jira's status category.
export function columnOf(issue) {
  const exact = COLUMNS.find((c) => c.toLowerCase() === issue.status.toLowerCase());
  if (exact) return exact;
  if (/backlog/i.test(issue.status)) return "Backlog";
  return issue.category === "done" ? "Done" : issue.category === "indeterminate" ? "In Progress" : "To Do";
}

// "[go-gql-api] - finality watermark" → "go-gql-api".
export const repoOf = (title) => title.match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() ?? null;

export function branchFor(issue) {
  const words = issue.title.replace(/^\s*\[[^\]]*\]\s*-?\s*/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${issue.key}-${words}`.slice(0, 48).replace(/-$/, "");
}

// The space already working on this ticket (key in its name or branch), and the repo's space.
export function spacesFor(issue, list) {
  const key = issue.key.toLowerCase(), repo = repoOf(issue.title)?.toLowerCase();
  const working = list.find((s) => s.name?.toLowerCase().includes(key) || s.branch?.toLowerCase().includes(key)) ?? null;
  const home = repo ? list.find((s) => s.name?.toLowerCase() === repo) ?? null : null;
  return { working, home };
}

// PRs mentioning the key, from every gh account (same accounts as Pulse).
async function prsFor(key) {
  const st = await exec("gh", ["auth", "status", "--json", "hosts"]).catch(() => null);
  const accounts = Object.values(JSON.parse(st?.stdout || "{}").hosts ?? {}).flat().filter((a) => a.state === "success");
  const seen = new Map();
  await Promise.all(accounts.map(async (a) => {
    const r = await exec("sh", ["-c", 't="$(gh auth token -h "$1" -u "$2")" || exit 1; shift 2; GH_TOKEN="$t" exec gh "$@"', "sh", a.host, a.login,
      "search", "prs", key, "--json", "number,title,url,state,repository", "--limit", "10"], { timeout: 30000 }).catch(() => null);
    try { for (const p of JSON.parse(r?.stdout || "[]")) if (!seen.has(p.url)) seen.set(p.url, p); } catch {}
  }));
  return [...seen.values()];
}

const tint = (c, a) => `${(c ?? "#888888").slice(0, 7)}${a}`;
function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
function openUrl(url) {
  const p = window()?.platform;
  const [cmd, args] = p === "macos" ? ["open", [url]] : p === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => null);
}

export default class Jira extends View {
  init(_props, cx) {
    this.project = "all";
    this.backlog = false;
    this.issues = null;
    try { const c = JSON.parse(localStorage.getItem(CACHE) ?? "null"); this.issues = c?.issues ?? null; this.at = c?.at; this.site = c?.site; } catch {}
    this.comment = InputState.new({ placeholder: "Add a comment…" });
    this.comment.on("submit", (_e, cx) => this.sendComment(cx));
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.cred = await credentials();
        if (!this.cred) { this.setup = true; return; }
        this.setup = false; this.site = this.cred.site;
        this.issues = await loadIssues(this.cred);
        this.at = Date.now();
        try { localStorage.setItem(CACHE, JSON.stringify({ issues: this.issues, at: this.at, site: this.site })); } catch {}
        const open = this.issues.filter((i) => !["Done", "Backlog"].includes(columnOf(i))).length;
        if (shared("jira.open") !== open) setShared("jira.open", open);
        if (this.selected && !this.issues.some((i) => i.key === this.selected)) this.selected = null;
      } catch (e) {
        this.error = String(e.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  select(key, cx) {
    if (this.selected === key) { this.selected = null; cx.notify(); return; }
    this.selected = key; this.prs = null; this.transitions = null; this.moveOpen = false; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const prs = await prsFor(key).catch(() => []);
      if (this.selected === key) { this.prs = prs; cx.notify(); }
    });
  }

  // Every write is a click: nothing here runs on its own.
  write(cx, label, fn) {
    if (this.busy || !this.cred) return;
    this.busy = label; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(); this.note = `${label} ✓`; }
      catch (e) { this.note = `${label} failed: ${e.message ?? e}`; }
      finally { this.busy = null; cx.notify(); this.refresh(cx); }
    });
  }

  openMove(cx) {
    this.moveOpen = !this.moveOpen; cx.notify();
    if (!this.moveOpen || !this.cred) return;
    const key = this.selected;
    cx.spawn(async (cx) => {
      try { const d = await api(this.cred, "GET", `/rest/api/3/issue/${key}/transitions`); if (this.selected === key) this.transitions = d.transitions ?? []; }
      catch (e) { this.note = String(e.message ?? e); }
      cx.notify();
    });
  }

  move(tr, cx) {
    const key = this.selected;
    this.moveOpen = false;
    this.write(cx, `Moved ${key} to ${tr.to?.name ?? tr.name}`, () => api(this.cred, "POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id } }));
  }

  assignToMe(cx) {
    const key = this.selected;
    this.write(cx, `Assigned ${key} to you`, async () => {
      const me = await api(this.cred, "GET", "/rest/api/3/myself");
      await api(this.cred, "PUT", `/rest/api/3/issue/${key}/assignee`, { accountId: me.accountId });
    });
  }

  sendComment(cx) {
    const text = this.comment.value().trim(), key = this.selected;
    if (!text || !key) return;
    this.write(cx, `Commented on ${key}`, async () => {
      await api(this.cred, "POST", `/rest/api/3/issue/${key}/comment`, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } });
      this.comment.set_value("");
    });
  }

  // ---- view ----

  btn(t, id, label, action, primary) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(6).border(1).cursor_pointer().text_size(12)
      .border_color(primary ? t.accent : t.border).text_color(primary ? t.accent : t.foreground).bg(t.background)
      .hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  pill(text, color) {
    return div().px(6).h(16).flex().items_center().rounded(8).bg(tint(color, "26")).text_color(color).text_size(10.5).font_medium().child(text);
  }

  colColor(t, col) {
    return { "To Do": t.dim, "In Progress": t.ansi4, "In Review": t.ansi3, "Stage QA": t.ansi5, Done: t.ansi2, Backlog: t.dim }[col] ?? t.dim;
  }

  sidebar(t, all) {
    const w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const open = (list) => list.filter((i) => !["Done", "Backlog"].includes(columnOf(i))).length;
    const projects = [...new Map(all.map((i) => [i.project, i.projectName])).entries()].sort();
    const row = (id, label, count, on, action, lead) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action)
      .when(Boolean(lead), (el) => el.child(lead))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().text_size(11).text_color(t.dim).child(String(count)));
    const label = (text) => div().px(8).pt(14).pb(4).text_size(11).text_color(t.dim).font_medium().child(text);
    return v_flex().w(232).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).text_size(13)
      .child(h_flex().h(46).pl(lights ? 30 : 16).pr(10).items_center().gap(8)
        .child(svg("mods/rail/kanban.svg").size(15).text_color(t.accent))
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Jira")))
      .child(v_flex().px(8).gap(1)
        .when(Boolean(this.site), (el) => el.child(div().px(8).text_size(11.5).text_color(t.dim).truncate().child(this.site)))
        .child(label("PROJECTS"))
        .child(row("p-all", "All projects", open(all), this.project === "all", (_e, cx) => { this.project = "all"; cx.notify(); }))
        .children(projects.map(([k, name]) => row(`p-${k}`, name ? `${k} · ${name}` : k, open(all.filter((i) => i.project === k)), this.project === k,
          (_e, cx) => { this.project = k; cx.notify(); },
          div().w(18).text_size(10).font_semibold().text_color(t.muted).child(k.slice(0, 3)))))
        .child(label("SHOW"))
        .child(row("backlog", "Backlog", all.filter((i) => columnOf(i) === "Backlog").length, this.backlog, (_e, cx) => { this.backlog = !this.backlog; cx.notify(); })))
      .child(div().flex_1())
      .child(h_flex().id("refresh").h(40).px(16).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.refresh(cx))
        .when(Boolean(this.loading), (el) => el.child(svg("mods/jira/spinner.svg").size(12).spin(900)))
        .child(this.loading ? "Refreshing…" : this.at ? `Synced ${new Date(this.at).toTimeString().slice(0, 5)} · Refresh` : "Refresh"));
  }

  kpis(t, list) {
    const n = (c) => list.filter((i) => columnOf(i) === c).length;
    const tile = (label, value, sub, tone) => v_flex().flex_1().min_w(0).px(12).py(10).gap(2).rounded(8).border(1)
      .border_color(tone ?? t.border).bg(tone ? tint(tone, "14") : t.background)
      .child(div().text_size(11).text_color(t.muted).truncate().child(label))
      .child(div().text_size(22).font_semibold().text_color(t.foreground).child(String(value)))
      .child(div().text_size(11).text_color(t.muted).truncate().child(sub));
    const active = list.filter((i) => !["Done", "Backlog"].includes(columnOf(i))).length;
    return h_flex().gap(10)
      .child(tile("Assigned to me", active, `${n("Backlog")} more in backlog`))
      .child(tile("In progress", n("In Progress"), `${n("To Do")} waiting in To Do`))
      .child(tile("In review + QA", n("In Review") + n("Stage QA"), `${n("In Review")} review · ${n("Stage QA")} QA`, n("In Review") + n("Stage QA") ? t.ansi3 : null))
      .child(tile(`Done · ${DONE_DAYS} days`, n("Done"), "moved to Done"));
  }

  card(t, i, col) {
    const on = this.selected === i.key;
    return v_flex().id(`tk-${i.key}`).min_w(0).gap(3).px(8).py(6).rounded(6).border(1).border_color(on ? t.accent : t.border)
      .border_l(3).border_color(on ? t.accent : this.colColor(t, col)).bg(t.background).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(i.key, cx))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().font_semibold().text_color(t.foreground).child(i.key))
        .child(div().child(i.type))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(ago(i.updated))))
      .child(div().text_size(12.5).text_color(t.foreground).child(i.title));
  }

  board(t, list) {
    const cols = this.backlog ? ["Backlog", ...COLUMNS] : COLUMNS;
    return v_flex().min_w(0).border(1).border_color(t.border).rounded(8).bg(t.background)
      .child(h_flex().h(36).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("My board"))
        .child(div().text_size(11.5).text_color(t.muted).child(`${list.filter((i) => cols.includes(columnOf(i))).length} tickets`)))
      .child(h_flex().items_start().children(cols.map((c, idx) => {
        const items = list.filter((i) => columnOf(i) === c);
        return v_flex().flex_1().min_w(0).p(8).gap(6).when(idx < cols.length - 1, (el) => el.border_r(1).border_color(t.border))
          .child(h_flex().gap(6).items_center().text_size(12)
            .child(div().size(8).rounded(4).bg(this.colColor(t, c)))
            .child(div().font_semibold().text_color(t.foreground).child(c))
            .child(div().text_color(t.muted).child(String(items.length))))
          .children(items.length ? items.map((i) => this.card(t, i, c)) : [div().text_size(11.5).text_color(t.dim).child("Nothing here")]);
      })));
  }

  detail(t, i) {
    const { working, home } = spacesFor(i, spaces());
    const repo = repoOf(i.title), branch = branchFor(i);
    const link = (id, icon, text, sub, action) => h_flex().id(id).min_w(0).gap(8).px(8).py(6).rounded(6).border(1).border_color(t.border).items_center()
      .when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action))
      .child(div().w(22).text_size(10.5).font_semibold().text_color(t.muted).child(icon))
      .child(v_flex().flex_1().min_w(0).child(div().text_size(12.5).truncate().child(text)).when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(t.muted).truncate().child(sub))));
    const prs = this.prs == null
      ? [div().text_size(11.5).text_color(t.dim).child("Looking for PRs…")]
      : this.prs.length ? this.prs.map((p) => link(`pr-${p.url}`, "PR", p.title, `${p.repository?.nameWithOwner ?? ""} #${p.number} · ${p.state.toLowerCase()}`, () => openUrl(p.url)))
        : [link("pr-none", "PR", `No PR mentions ${i.key} yet`, null, null)];
    const space = working
      ? link("space", "▤", working.name, working.branch ? `branch ${working.branch}` : null, () => { run("space.select", { id: working.id }); run("layout.select", { stack: "screens", child: "workspace" }); })
      : link("space", "▤", `No space on ${i.key} yet`, home ? `"Start work" makes ${branch} in ${home.name}` : repo ? `no space named ${repo}` : null, null);
    const start = () => {
      run("layout.select", { stack: "screens", child: "workspace" });
      openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: home.id, branch } });
    };
    return v_flex().min_w(0).border(1).border_color(t.border).rounded(8).bg(t.background).p(12).gap(10)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().font_semibold().text_color(t.muted).child(i.key))
        .child(div().flex_1().min_w(0).font_semibold().truncate().child(i.title))
        .child(this.pill(i.status, this.colColor(t, columnOf(i)))))
      .child(v_flex().gap(6).children([...prs, space]))
      .child(h_flex().gap(6).items_center()
        .when(Boolean(working), (el) => el.child(this.btn(t, "go-space", "Open in space", () => { run("space.select", { id: working.id }); run("layout.select", { stack: "screens", child: "workspace" }); }, true)))
        .when(!working && Boolean(home), (el) => el.child(this.btn(t, "start", "Start work", start, true)))
        .child(this.btn(t, "open-jira", "Open in Jira", () => openUrl(`https://${this.site}/browse/${i.key}`)))
        .child(this.btn(t, "move", this.moveOpen ? "Move to ▴" : "Move to ▾", (_e, cx) => this.openMove(cx)))
        .child(this.btn(t, "assign", "Assign to me", (_e, cx) => this.assignToMe(cx)))
        .when(Boolean(this.busy), (el) => el.child(svg("mods/jira/spinner.svg").size(12).spin(900)))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(this.note))))
      .when(Boolean(this.moveOpen), (el) => el.child(h_flex().gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.muted).child("Move to:"))
        .children(this.transitions == null ? [div().text_size(11.5).text_color(t.dim).child("loading…")]
          : this.transitions.map((tr) => this.btn(t, `tr-${tr.id}`, tr.to?.name ?? tr.name, (_e, cx) => this.move(tr, cx))))))
      .child(h_flex().gap(6).items_center()
        .child(div().id("comment").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(6).border(1).border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.comment).h_full().text_size(12).text_color(t.foreground)))
        .child(this.btn(t, "send", "Comment", (_e, cx) => this.sendComment(cx))));
  }

  message(t, title, body, code) {
    return v_flex().flex_1().items_center().justify_center().gap(8).text_color(t.muted).p(24)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12.5).max_w(520).child(body))
      .when(Boolean(code), (el) => el.child(div().id("setup-cmd").px(10).py(6).rounded(6).bg(t.surface).border(1).border_color(t.border)
        .font_family("JetBrains Mono").text_size(11.5).text_color(t.foreground).cursor_pointer().tooltip("Click to copy")
        .on_click((_e, cx) => cx.write_to_clipboard(code)).child(code)));
  }

  render() {
    const t = theme(), all = this.issues ?? [];
    let body;
    if (this.setup && !this.issues) body = this.message(t, "Connect Jira",
      "Make an API token at id.atlassian.com → Security → API tokens. Then run this in a terminal with your email and site, and paste the token when asked. Click Refresh after.", SETUP);
    else if (!this.issues) body = this.error ? this.message(t, "Can't reach Jira", this.error) : this.message(t, "Loading your tickets…", "Asking Jira for everything assigned to you");
    else {
      const list = this.project === "all" ? all : all.filter((i) => i.project === this.project);
      const sel = all.find((i) => i.key === this.selected);
      body = v_flex().id("jira-scroll").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(16).gap(16)
        .child(h_flex().gap(10).items_center()
          .child(div().text_size(18).font_semibold().child(this.project === "all" ? "All projects" : this.project))
          .child(div().text_size(12).text_color(t.muted).child(`assigned to me · Done from the last ${DONE_DAYS} days`)))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(`Refresh failed: ${this.error}`)))
        .child(this.kpis(t, list))
        .when(Boolean(sel), (el) => el.child(this.detail(t, sel)))
        .child(this.board(t, list));
    }
    return h_flex().size_full().bg(t.canvas ?? t.background).text_color(t.foreground)
      .child(this.sidebar(t, all))
      .child(body);
  }
}
