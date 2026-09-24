// ─── Comment tree helpers (Requirement 5.11–5.18) ──────────────────────────────
// Pure functions over the recursive CommentNode tree shared by App and db.ts.

import type { CommentNode } from "../types";

/** Total nodes in a tree (comments + all nested replies). Tolerates missing `replies`. */
export function countCommentNodes(nodes: CommentNode[] | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce((n, node) => n + 1 + countCommentNodes(node?.replies), 0);
}

/** Does the subtree rooted at `node` contain a node with this id? */
export function nodeContains(node: CommentNode, id: string): boolean {
  if (node.id === id) return true;
  return (node.replies ?? []).some(r => nodeContains(r, id));
}

/** Immutably append `reply` under the node whose id is `parentId`, at any depth. */
export function addReply(nodes: CommentNode[], parentId: string, reply: CommentNode): CommentNode[] {
  return nodes.map(n =>
    n.id === parentId
      ? { ...n, replies: [...(n.replies ?? []), reply] }
      : { ...n, replies: addReply(n.replies ?? [], parentId, reply) },
  );
}

/** Top-level threads the viewer may see: public ones, or private ones they wrote or that are on their post. */
export function visibleThreads(comments: CommentNode[], viewerId: string, postAuthorId: string): CommentNode[] {
  return comments.filter(c =>
    (c.visibility ?? "public") === "public" || viewerId === postAuthorId || c.author_id === viewerId,
  );
}

export interface CommentRow {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string | null;
  message: string;
  visibility: string | null;
  created_at: string;
}

/** Rebuild the per-post nested trees from flat db rows (oldest first at every level). */
export function rowsToCommentMap(rows: CommentRow[]): Record<string, CommentNode[]> {
  const nodeById = new Map<string, CommentNode>();
  for (const r of rows) {
    nodeById.set(r.id, {
      id: r.id,
      author_id: r.author_id,
      author_name: r.author_name ?? "",
      message: r.message,
      created_at: r.created_at,
      visibility: r.visibility === "private" ? "private" : "public",
      replies: [],
    });
  }
  const byPost: Record<string, CommentNode[]> = {};
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of sorted) {
    const node = nodeById.get(r.id)!;
    if (r.parent_id && nodeById.has(r.parent_id)) {
      nodeById.get(r.parent_id)!.replies.push(node);
    } else {
      (byPost[r.post_id] ??= []).push(node);
    }
  }
  return byPost;
}
