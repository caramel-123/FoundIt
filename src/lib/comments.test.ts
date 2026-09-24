import { test } from "node:test";
import assert from "node:assert/strict";
import { countCommentNodes, nodeContains, addReply, visibleThreads, rowsToCommentMap, type CommentRow } from "./comments.ts";
import type { CommentNode } from "../types";

const node = (id: string, replies: CommentNode[] = [], extra: Partial<CommentNode> = {}): CommentNode => ({
  id, author_id: "a", author_name: "A", message: id, created_at: "2026-09-24T00:00:00Z", replies, ...extra,
});

test("countCommentNodes counts every level and tolerates missing replies", () => {
  const tree = [node("c1", [node("r1", [node("r2")])]), node("c2")];
  assert.equal(countCommentNodes(tree), 4);
  assert.equal(countCommentNodes(undefined), 0);
  assert.equal(countCommentNodes([{ ...node("x"), replies: undefined as unknown as CommentNode[] }]), 1);
});

test("addReply appends at any depth without mutating the input", () => {
  const tree = [node("c1", [node("r1")])];
  const next = addReply(tree, "r1", node("r2"));
  assert.equal(next[0].replies[0].replies[0].id, "r2");
  assert.equal(tree[0].replies[0].replies.length, 0);
  assert.ok(nodeContains(next[0], "r2"));
  assert.ok(!nodeContains(tree[0], "r2"));
});

test("visibleThreads hides private threads from everyone but the post author and commenter", () => {
  const comments = [
    node("pub"),
    node("priv", [], { visibility: "private", author_id: "commenter" }),
  ];
  assert.deepEqual(visibleThreads(comments, "stranger", "poster").map(c => c.id), ["pub"]);
  assert.deepEqual(visibleThreads(comments, "poster", "poster").map(c => c.id), ["pub", "priv"]);
  assert.deepEqual(visibleThreads(comments, "commenter", "poster").map(c => c.id), ["pub", "priv"]);
});

test("rowsToCommentMap nests replies under parents, oldest first, per post", () => {
  const row = (id: string, post_id: string, parent_id: string | null, created_at: string): CommentRow => ({
    id, post_id, parent_id, author_id: "a", author_name: null, message: id, visibility: null, created_at,
  });
  const map = rowsToCommentMap([
    row("r1", "p1", "c1", "2026-09-24T00:02:00Z"),
    row("c2", "p1", null, "2026-09-24T00:03:00Z"),
    row("c1", "p1", null, "2026-09-24T00:01:00Z"),
    row("orphan", "p2", "missing", "2026-09-24T00:04:00Z"),
  ]);
  assert.deepEqual(map.p1.map(c => c.id), ["c1", "c2"]);
  assert.equal(map.p1[0].replies[0].id, "r1");
  assert.equal(map.p1[0].author_name, "");
  assert.equal(map.p1[0].visibility, "public");
  assert.deepEqual(map.p2.map(c => c.id), ["orphan"]); // unknown parent → top level
});
