// One markdown note, saved as notes.md in the app folder. Edit on the left, preview on the right.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextareaState, TextView } from "gpui-base";
import { theme, window, appHome, readTextFile, writeTextFile } from "herdr";

export default class Notes extends View {
  init(_props, cx) {
    this.path = `${appHome()}/notes.md`;
    this.saved = null; this.text = ""; this.loaded = false; this.writing = false; this.error = null;
    this.editor = TextareaState.new({ placeholder: "Write markdown here..." });
    this.editor.on("change", (_e, cx) => { this.text = this.editor.value(); this.save(cx); });
    cx.spawn(async (cx) => {
      try {
        this.saved = await readTextFile(this.path);
        this.text = this.saved ?? "";
        this.editor.set_value(this.text);
      } catch (e) { this.error = `Could not read notes.md: ${e.message ?? e}`; }
      this.loaded = true; cx.notify();
    });
  }

  // Saves the latest text; keystrokes during a write are picked up by the loop, so writes never overlap.
  save(cx) {
    if (!this.loaded || this.writing) { cx.notify(); return; }
    this.writing = true;
    cx.spawn(async (cx) => {
      try {
        while (this.text !== (this.saved ?? "")) {
          const text = this.text;
          await writeTextFile(this.path, text, this.saved);
          this.saved = text;
        }
        this.error = null;
      } catch (e) { this.error = `Not saved (${e.message ?? e}). notes.md changed on disk: restart the screen to reload it.`; }
      finally { this.writing = false; cx.notify(); }
    });
    cx.notify();
  }

  render() {
    const t = theme(), w = window(), lights = w?.platform === "macos" && !w?.fullscreen;
    const status = this.error ?? (!this.loaded ? "Loading..." : this.writing || this.text !== (this.saved ?? "") ? "Saving..." : "Saved");
    return v_flex().size_full().bg(t.background).text_color(t.foreground).p(12).gap(8)
      .child(h_flex().h(28).pl(lights ? 20 : 0).items_center().gap(10)
        .child(div().font_semibold().child("Notes"))
        .child(div().text_size(11).text_color(this.error ? t.ansi1 : t.muted).child(status)))
      .child(h_flex().flex_1().min_h(0).gap(10)
        .child(div().id("notes-editor").flex_1().min_w(0).h_full().p(8).rounded(5).border(1).border_color(t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.editor).size_full().text_size(13).text_color(t.foreground)))
        .child(v_flex().id("notes-preview").flex_1().min_w(0).h_full().p(8).overflow_y_scrollbar().text_size(13)
          .child(this.text ? TextView.markdown("notes-markdown", this.text).selectable(true)
            : div().text_color(t.muted).child("Preview appears here."))));
  }
}
