// Markdown notes: one .md file per note in <appHome>/notes/. Pick a note on the left, edit it in the middle, preview on the right.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Textarea, TextareaState, TextView } from "gpui-base";
import { theme, window, appHome, checking, exec, readTextFile, writeTextFile } from "herdr";

// "My idea!" -> "My-idea.md"; no slashes or leading dots, so a name can't leave the folder.
export function noteFile(input) {
  const base = input.trim().replace(/\.md$/i, "").replace(/[^\p{L}\p{N} _.-]+/gu, "-").replace(/^[.\s-]+|[\s-]+$/g, "");
  return base ? `${base}.md` : null;
}

export default class Notes extends View {
  init(_props, cx) {
    this.dir = `${appHome()}/notes`;
    this.names = []; this.name = null; this.saved = ""; this.text = ""; this.writing = null; this.error = null;
    this.editor = TextareaState.new({ placeholder: "Write markdown here..." });
    this.editor.on("change", (_e, cx) => { this.text = this.editor.value(); this.save(cx); });
    this.title = InputState.new({ placeholder: "New note name" });
    this.title.on("submit", (_e, cx) => this.create(cx));
    cx.spawn(async (cx) => {
      try {
        if (!checking()) await exec("mkdir", ["-p", this.dir]);
        await this.refresh();
        if (this.names[0]) await this.load(this.names[0]);
      } catch (e) { this.error = String(e.message ?? e); }
      this.ready = true; cx.notify();
    });
  }

  async refresh() {
    const r = await exec("ls", ["-t", this.dir]); // newest first
    this.names = r.stdout.split("\n").filter((n) => n.endsWith(".md"));
  }

  async load(name) {
    const text = (await readTextFile(`${this.dir}/${name}`)) ?? "";
    this.name = name; this.saved = text; this.text = text;
    this.editor.set_value(text);
  }

  // Saves the latest text; keystrokes during a write are picked up by the loop, so writes never overlap.
  save(cx) {
    if (!this.name || this.writing) { cx.notify(); return; }
    this.writing = (async () => {
      try {
        while (this.text !== this.saved) {
          const text = this.text;
          await writeTextFile(`${this.dir}/${this.name}`, text, this.saved);
          this.saved = text;
        }
        this.error = null;
      } catch (e) { this.error = `Not saved: ${e.message ?? e}. The file changed on disk; reopen the note.`; this.saved = this.text; }
      finally { this.writing = null; cx.notify(); }
    })();
    cx.notify();
  }

  open(name, cx) {
    if (name === this.name) return;
    cx.spawn(async (cx) => {
      try {
        await this.writing; // finish saving the note we're leaving
        await this.load(name);
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  create(cx) {
    const name = noteFile(this.title.value());
    if (!name) return;
    this.title.set_value("");
    cx.spawn(async (cx) => {
      try {
        await this.writing;
        if (!this.names.includes(name)) await writeTextFile(`${this.dir}/${name}`, "", null);
        await this.refresh();
        await this.load(name);
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  render() {
    const t = theme(), w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const status = this.error ?? (!this.name ? "" : this.writing || this.text !== this.saved ? "Saving..." : "Saved");
    const sidebar = v_flex().id("notes-list").w(200).flex_none().h_full().overflow_y_scrollbar()
      .bg(t.chrome).border_r(1).border_color(t.border).p(10).gap(6)
      .child(div().h(28).pl(lights ? 20 : 0).flex().items_center().font_semibold().child("Notes"))
      .child(h_flex().gap(6).items_center()
        .child(div().id("notes-name").flex_1().min_w(0).h(28).px(6).flex().items_center().rounded(5).border(1).border_color(t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.title).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("notes-new").px(8).h(28).flex().items_center().rounded(5).border(1).border_color(t.border)
          .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.create(cx)).child("New")))
      .children(this.names.map((n, i) => div().id(`note-${i}`).px(6).py(4).rounded(5).truncate().text_size(13).cursor_pointer()
        .bg(n === this.name ? t.selected : t.chrome).hover((s) => s.bg(t.hover)).tooltip(n)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.open(n, cx)).child(n.replace(/\.md$/, ""))))
      .when(this.ready && this.names.length === 0, (el) => el.child(div().text_size(11).text_color(t.muted).child("No notes yet. Type a name and press New.")));
    const page = !this.name
      ? div().flex_1().flex().items_center().justify_center().text_color(t.muted).child(this.ready ? "Create or pick a note." : "Loading...")
      : v_flex().flex_1().min_w(0).h_full().p(12).gap(8)
        .child(h_flex().h(28).items_center().gap(10)
          .child(div().font_semibold().truncate().child(this.name.replace(/\.md$/, "")))
          .child(div().text_size(11).text_color(this.error ? t.ansi1 : t.muted).child(status)))
        .child(h_flex().flex_1().min_h(0).gap(10)
          .child(div().id("notes-editor").flex_1().min_w(0).h_full().p(8).rounded(5).border(1).border_color(t.input)
            .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Textarea.new(this.editor).size_full().text_size(13).text_color(t.foreground)))
          .child(v_flex().id("notes-preview").flex_1().min_w(0).h_full().p(8).overflow_y_scrollbar().text_size(13)
            .child(this.text ? TextView.markdown("notes-markdown", this.text).selectable(true)
              : div().text_color(t.muted).child("Preview appears here."))));
    return h_flex().size_full().bg(t.background).text_color(t.foreground).child(sidebar).child(page);
  }
}
