import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, run, layout, window, shared } from "herdr";

// Each screen is a child of the layout's "screens" stack. A new screen: add a
// child there and a row here.
const SCREENS = [
  { id: "workspace", icon: "mods/rail/workspace.svg", label: "Workspace" },
  { id: "pulse", icon: "mods/rail/activity.svg", label: "Pulse", badge: "pulse.attention" },
  { id: "jira", icon: "mods/rail/kanban.svg", label: "Jira" },
  { id: "slack", icon: "mods/rail/slack.svg", label: "Slack" },
  { id: "notes", icon: "mods/rail/notes.svg", label: "Notes" },
  { id: "usage", icon: "mods/rail/usage.svg", label: "Usage" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Rail extends View {
  render() {
    const t = theme(), w = window();
    const active = find(layout(), "screens")?.active ?? "workspace";
    // macOS draws its window buttons over the top-left corner.
    const lights = w?.platform === "macos" && !w?.fullscreen;
    // Its own divider, starting below the window buttons so it doesn't run through them.
    return v_flex().size_full().relative().bg(t.chrome).items_center().gap(6).pt(lights ? 44 : 10)
      .child(div().absolute().top(lights ? 42 : 0).bottom(0).right(0).w(1).bg(t.border))
      .children(SCREENS.map((s) => {
        const on = s.id === active, count = s.badge ? Number(shared(s.badge) ?? 0) : 0;
        return div().id(`rail-${s.id}`).relative().size(34).flex().items_center().justify_center().rounded(8).cursor_pointer()
          .tooltip(s.label)
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => run("layout.select", { stack: "screens", child: s.id }))
          .child(svg(s.icon).size(17))
          .when(count > 0, (el) => el.child(
            div().absolute().top(-4).right(-4).px(4).h(15).rounded(8).bg(t.accent).text_color(t.accent_foreground)
              .text_size(9.5).font_semibold().flex().items_center().child(count > 99 ? "99+" : String(count))));
      }));
  }
}
