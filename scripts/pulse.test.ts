import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The My PRs page's merge rules, without a window or gh.
const source = await readFile(new URL("../defaults/mods/pulse/main.js", import.meta.url), "utf8");
const { mergeState, methods } = new Function("View", source.replace(/^import .*;\n/gm, "").replace(/^export (default )?/gm, "") + "\nreturn { mergeState, methods };")(class {});

test("merge button follows GitHub's merge state", () => {
  expect(mergeState({ mergeStateStatus: "CLEAN" })).toMatchObject({ ok: true });
  expect(mergeState({ mergeStateStatus: "UNSTABLE" })).toMatchObject({ ok: true });
  expect(mergeState({ mergeStateStatus: "BLOCKED" })).toMatchObject({ ok: false, auto: true });
  expect(mergeState({ mergeStateStatus: "BEHIND" })).toMatchObject({ ok: false, update: true });
  expect(mergeState({ mergeable: "CONFLICTING", mergeStateStatus: "CLEAN" })).toMatchObject({ ok: false, why: "merge conflicts" });
  expect(mergeState({ isDraft: true, mergeStateStatus: "CLEAN" })).toMatchObject({ ok: false, why: "draft" });
  expect(mergeState({ mergeStateStatus: "UNKNOWN" })).toMatchObject({ ok: false, why: "GitHub is checking" });
});

test("merge methods: only allowed ones, last used first", () => {
  const repo = { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "REBASE" };
  expect(methods({ repository: repo })).toEqual(["rebase", "squash"]);
  // An older cache has no flags: offer everything.
  expect(methods({ repository: { nameWithOwner: "a/b" } })).toEqual(["squash", "merge", "rebase"]);
});
