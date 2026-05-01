import test from "node:test";
import assert from "node:assert/strict";
import { getOpenGroupsForSlug } from "../lib/docs/sidebar-state.mjs";
import {
  getNextSelectedIndex,
  shouldApplySearchResponse,
} from "../lib/docs/search-modal-state.mjs";

const docsNav = [
  { title: "Overview", slug: "" },
  { title: "Getting Started", slug: "getting-started" },
  {
    title: "Guides",
    slug: "",
    children: [
      { title: "Tutorial", slug: "tutorial" },
      { title: "Migration Guide", slug: "migration" },
      { title: "CLI Tool", slug: "cli" },
    ],
  },
];

test("getOpenGroupsForSlug opens the parent group for the active child slug", () => {
  const openGroups = getOpenGroupsForSlug(docsNav, "tutorial");

  assert.deepEqual(openGroups, ["Guides"]);
});

test("getOpenGroupsForSlug returns an empty list for top-level pages", () => {
  const openGroups = getOpenGroupsForSlug(docsNav, "getting-started");

  assert.deepEqual(openGroups, []);
});

test("getNextSelectedIndex stays at zero when there are no results", () => {
  assert.equal(getNextSelectedIndex(0, 1, 0), 0);
  assert.equal(getNextSelectedIndex(0, -1, 0), 0);
});

test("getNextSelectedIndex clamps within the result bounds", () => {
  assert.equal(getNextSelectedIndex(0, 1, 3), 1);
  assert.equal(getNextSelectedIndex(2, 1, 3), 2);
  assert.equal(getNextSelectedIndex(0, -1, 3), 0);
});

test("shouldApplySearchResponse only accepts the latest open request", () => {
  assert.equal(
    shouldApplySearchResponse({ isOpen: true, latestRequestId: 2, requestId: 2 }),
    true
  );
  assert.equal(
    shouldApplySearchResponse({ isOpen: true, latestRequestId: 2, requestId: 1 }),
    false
  );
  assert.equal(
    shouldApplySearchResponse({ isOpen: false, latestRequestId: 2, requestId: 2 }),
    false
  );
});
