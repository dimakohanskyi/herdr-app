// OpenSpec changes of the focused pane's repo: read the artifacts, start a
// discussion, apply a change in its own worktree.
// ponytail: agent and slash commands are constants; a setting when someone needs another agent.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, run, openOverlay } from "herdr";

const AGENT = ["claude"];
const DISCUSS = "/opsx:explore ";
const APPLY = (id) => `/opsx:apply ${id}`;
const ARTIFACTS = ["proposal.md", "design.md", "tasks.md"];

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space: space?.id, cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}
const key = () => JSON.stringify(location());

export default class OpenSpec extends View {
  init(_props, cx) {
    this.changes = []; this.open = null; this.doc = "proposal.md"; this.text = null;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const where = location(), k = key();
    if (k !== this.key) { this.key = k; this.root = null; this.changes = []; this.open = null; this.text = null; this.error = null; }
    if (!where.cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: where.cwd, on: where.on });
        if (key() !== k) return;
        if (top.code !== 0) { this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        const list = await exec("openspec", ["list", "--json"], { cwd: root, on: where.on });
        if (key() !== k) return;
        if (list.code !== 0) { this.error = (list.stderr || list.stdout).trim() || "openspec list failed (is the openspec CLI installed?)"; return; }
        this.root = root; this.on = where.on; this.space = where.space; this.error = null;
        this.changes = JSON.parse(list.stdout).changes ?? [];
        if (this.open && !this.changes.some((c) => c.name === this.open)) { this.open = null; this.text = null; }
        if (this.open) await this.load();
      } catch (e) { if (key() === k) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load() {
    const text = await readTextFile(`${this.root}/openspec/changes/${this.open}/${this.doc}`, { on: this.on }).catch(() => null);
    this.text = text ?? `No ${this.doc} yet.`;
  }

  show(name, doc, cx) {
    this.open = name; this.doc = doc; this.text = null;
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
    cx.notify();
  }

  discuss() {
    run("tab.new", { name: "openspec", space: this.space, folder: this.root, argv: AGENT, task: DISCUSS });
  }

  apply(name) {
    openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280,
      props: { space: this.space, folder: this.root, action: "new", branch: name, argv: [...AGENT, APPLY(name)] } });
  }

  render(cx) {
    if (key() !== this.key) this.refresh(cx);
    const t = theme();
    const button = (id, label, action) => div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(11)
      .border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action).child(label);
    const row = (c) => {
      const done = c.totalTasks ? `${c.completedTasks}/${c.totalTasks}` : "no tasks";
      return v_flex().id(`change-${c.name}`).flex_none().p(8).gap(6).rounded(7).when(this.open === c.name, (e) => e.bg(t.selected))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(c.name))
          .child(div().text_size(11).text_color(c.totalTasks && c.completedTasks === c.totalTasks ? t.ansi2 : t.dim).child(done)))
        .child(h_flex().gap(4)
          .children(ARTIFACTS.map((doc) => button(`${c.name}-${doc}`, doc.replace(".md", ""), (_e, cx) => this.show(c.name, doc, cx))))
          .child(div().flex_1())
          .child(button(`${c.name}-apply`, "Apply in worktree", () => this.apply(c.name))));
    };
    return v_flex().id("openspec").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("OpenSpec"))
        .child(div().flex_1())
        .when(Boolean(this.root), (e) => e.child(button("discuss", "New change", () => this.discuss()))))
      .child(v_flex().id("openspec-list").flex_none().max_h(260).overflow_y_scrollbar().p(6).gap(2)
        .children(this.changes.map(row))
        .when(!this.changes.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : this.root ? "No active changes" : "No folder")))))
      .when(Boolean(this.open), (e) => e.child(div().id("openspec-doc").flex_1().min_h(0).p(14).border_t(1).border_color(t.border).overflow_y_scrollbar()
        .child(this.text === null ? div().text_color(t.dim).child("Loading…") : TextView.markdown(`openspec-${this.open}-${this.doc}`, this.text))));
  }
}
