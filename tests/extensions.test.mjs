import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, mergeViews, badgeText, stackChild, withStackChild } from "../mods/vx-activity/extensions-core.js";

test("parseManifest fills defaults and rejects bad manifests", () => {
  const { manifest } = parseManifest(JSON.stringify({ id: "hello", view: { props: { a: 1 } } }), "hello-ext");
  assert.deepEqual(manifest, {
    id: "hello", name: "hello", title: "hello", icon: "mods/hello-ext/icon.svg",
    view: { mod: "hello-ext", props: { a: 1 } }, badge: null, folder: "hello-ext",
  });
  assert.match(parseManifest("{bad", "x").error, /x\/vx-extension.json/);
  assert.match(parseManifest("[]", "x").error, /not an object/);
  assert.match(parseManifest('{"id":"no spaces"}', "x").error, /"id"/);
  assert.match(parseManifest('{"id":"ok","view":{"mod":"../evil"}}', "x").error, /view.mod/);
  assert.equal(parseManifest('{"id":"u","name":"Updates","title":"Tip","badge":"k"}', "x").manifest.badge, "k");
});

test("mergeViews appends extensions after built-ins, sorted, skipping taken ids", () => {
  const builtins = [{ id: "explorer" }, { id: "ext-dup" }];
  const manifests = ["zeta", "alpha", "dup"].map((id) => parseManifest(JSON.stringify({ id }), id).manifest);
  const views = mergeViews(builtins, manifests);
  assert.deepEqual(views.map((view) => view.id), ["explorer", "ext-dup", "ext-alpha", "ext-zeta"]);
  assert.equal(views[2].extension.id, "alpha");
});

test("badgeText accepts strings and positive numbers", () => {
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(1500), "999+");
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(" new "), "new");
  assert.equal(badgeText(""), null);
  assert.equal(badgeText({}), null);
});

test("withStackChild adds or updates the extension's stack child", () => {
  const view = mergeViews([], [parseManifest('{"id":"hi","view":{"props":{"n":1}}}', "hi").manifest])[0];
  const tree = { id: "root", children: [{ id: "sidebar-views", type: "stack", children: [{ id: "explorer" }] }] };
  const added = withStackChild(tree, "sidebar-views", stackChild(view));
  assert.deepEqual(added.children[0].children[1], { id: "ext-hi", type: "block", content: { mod: "hi", props: { n: 1 } } });
  assert.equal(tree.children[0].children.length, 1);
  assert.equal(withStackChild(added, "sidebar-views", stackChild(view)), null);
  const changed = { ...view, extension: { ...view.extension, view: { mod: "hi", props: { n: 2 } } } };
  assert.equal(withStackChild(added, "sidebar-views", stackChild(changed)).children[0].children[1].content.props.n, 2);
  assert.equal(withStackChild({ id: "root" }, "sidebar-views", stackChild(view)), null);
});
