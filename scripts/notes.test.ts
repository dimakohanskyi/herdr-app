import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/notes/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export (default )?/gm, "");
const { noteFile } = new Function("View", `${source}; return { noteFile };`)(class {});

test("note names become safe .md files inside the notes folder", () => {
  expect(noteFile("My idea!")).toBe("My idea.md");
  expect(noteFile("todo.md")).toBe("todo.md");
  expect(noteFile("../../etc/passwd")).toBe("etc-passwd.md");
  expect(noteFile(".hidden")).toBe("hidden.md");
  expect(noteFile("  ")).toBeNull();
  expect(noteFile("///")).toBeNull();
});
