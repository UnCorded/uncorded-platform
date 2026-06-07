// Stable id for the transient "ghost" leaf inserted into previewLayout while
// the user dwells mid-sidebar-drag. It never reaches the commit path — the
// preview memo assembles it with insertBesideLeaf and commit converts back to
// a freshly-uid'd real leaf in dropChannelToEdge. Special-cased in panel.tsx
// (renders a non-interactive placeholder) and drag-pill.tsx (docks into it).
export const PREVIEW_LEAF_ID = "__uncorded_preview_leaf__";

export type LeafNode = {
  type: "leaf";
  id: string;
};

export type SplitNode = {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PanelNode;
  second: PanelNode;
};

export type PanelNode = LeafNode | SplitNode;

function uid() {
  // Math.random is fine for non-security ids but a 7-char base36 sample
  // collides at ~16M tries, and panel layout state can outlive that across
  // long sessions. crypto.randomUUID is universally available in Solid's
  // target browsers and gives a guaranteed-unique handle.
  return crypto.randomUUID();
}

export function createLeaf(): LeafNode {
  return { type: "leaf", id: uid() };
}

export function splitLeaf(
  tree: PanelNode,
  id: string,
  direction: "horizontal" | "vertical"
): PanelNode {
  if (tree.type === "leaf" && tree.id === id) {
    return {
      type: "split",
      id: uid(),
      direction,
      ratio: 0.5,
      first: tree,
      second: createLeaf(),
    };
  }
  if (tree.type === "split") {
    return {
      ...tree,
      first: splitLeaf(tree.first, id, direction),
      second: splitLeaf(tree.second, id, direction),
    };
  }
  return tree;
}

export function closeLeaf(tree: PanelNode, id: string): PanelNode {
  if (tree.type === "leaf") return tree;
  if (tree.first.type === "leaf" && tree.first.id === id) return tree.second;
  if (tree.second.type === "leaf" && tree.second.id === id) return tree.first;
  return {
    ...tree,
    first: closeLeaf(tree.first, id),
    second: closeLeaf(tree.second, id),
  };
}

export function updateRatio(tree: PanelNode, id: string, ratio: number): PanelNode {
  if (tree.type === "leaf") return tree;
  if (tree.id === id) return { ...tree, ratio };
  return {
    ...tree,
    first: updateRatio(tree.first, id, ratio),
    second: updateRatio(tree.second, id, ratio),
  };
}

export function countLeaves(node: PanelNode): number {
  if (node.type === "leaf") return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

function findPath(tree: PanelNode, id: string): PanelNode[] | null {
  if (tree.type === "leaf") return tree.id === id ? [tree] : null;
  const inFirst = findPath(tree.first, id);
  if (inFirst) return [tree, ...inFirst];
  const inSecond = findPath(tree.second, id);
  if (inSecond) return [tree, ...inSecond];
  return null;
}

export function insertBesideLeaf(
  tree: PanelNode,
  targetId: string,
  newLeafId: string,
  direction: "horizontal" | "vertical",
  position: "before" | "after"
): PanelNode {
  const newLeaf: LeafNode = { type: "leaf", id: newLeafId };
  if (tree.type === "leaf" && tree.id === targetId) {
    return {
      type: "split",
      id: uid(),
      direction,
      ratio: 0.5,
      first: position === "before" ? newLeaf : tree,
      second: position === "before" ? tree : newLeaf,
    };
  }
  if (tree.type === "split") {
    return {
      ...tree,
      first: insertBesideLeaf(tree.first, targetId, newLeafId, direction, position),
      second: insertBesideLeaf(tree.second, targetId, newLeafId, direction, position),
    };
  }
  return tree;
}

// Collect every leaf id in DFS order.
export function getLeafIds(node: PanelNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...getLeafIds(node.first), ...getLeafIds(node.second)];
}

// Find the split that has `leafId` as one of its direct children. Returns null
// for the root leaf (it has no parent) or if the id is not in the tree.
export function findLeafParent(tree: PanelNode, leafId: string): SplitNode | null {
  if (tree.type === "leaf") return null;
  if ((tree.first.type === "leaf" && tree.first.id === leafId)
      || (tree.second.type === "leaf" && tree.second.id === leafId)) {
    return tree;
  }
  return findLeafParent(tree.first, leafId) ?? findLeafParent(tree.second, leafId);
}

// Outer-edge test: returns true if dropping at (direction, position) of
// `leafId` would land at the workspace boundary — i.e., there is no neighbour
// on that side of the leaf. Pure tree walk, no DOM measurements.
//
// The walk: from root down to the leaf, every descent through a split that
// shares the drop axis must go in the same direction as the drop. A
// disqualifying step means a sibling subtree sits between the leaf and the
// workspace edge, so the drop is "inner" (tight split next to leaf), not
// "outer" (full-width row / full-height column at the workspace edge).
//
//   bottom: any vertical split where we descend into `first` → inner
//   top:    any vertical split where we descend into `second` → inner
//   right:  any horizontal split where we descend into `first` → inner
//   left:   any horizontal split where we descend into `second` → inner
export function isOuterEdge(
  tree: PanelNode,
  leafId: string,
  direction: "horizontal" | "vertical",
  position: "before" | "after",
): boolean {
  const path = findPath(tree, leafId);
  if (!path) return false;
  for (let i = 0; i < path.length - 1; i++) {
    const node = path[i]!;
    if (node.type !== "split") continue;
    if (node.direction !== direction) continue;
    const child = path[i + 1]!;
    const wentFirst = node.first === child;
    if (position === "after" && wentFirst) return false;
    if (position === "before" && !wentFirst) return false;
  }
  return true;
}

// Wrap the entire tree in a new split at the root. Used for outer-edge drops
// to produce a full-width row / full-height column at the workspace boundary.
function wrapAtRoot(
  tree: PanelNode,
  newLeafId: string,
  direction: "horizontal" | "vertical",
  position: "before" | "after",
): PanelNode {
  const newLeaf: LeafNode = { type: "leaf", id: newLeafId };
  return {
    type: "split",
    id: uid(),
    direction,
    ratio: 0.5,
    first: position === "before" ? newLeaf : tree,
    second: position === "before" ? tree : newLeaf,
  };
}

// Edge-aware insert. Branches on `isOuterEdge`:
//   outer → wrap at root (full-width row / full-height column at the edge)
//   inner → insertBesideLeaf (tight 50/50 split next to the target leaf)
// Single entry point so preview and commit always agree.
export function insertAtEdge(
  tree: PanelNode,
  targetId: string,
  newLeafId: string,
  direction: "horizontal" | "vertical",
  position: "before" | "after",
): PanelNode {
  if (isOuterEdge(tree, targetId, direction, position)) {
    return wrapAtRoot(tree, newLeafId, direction, position);
  }
  return insertBesideLeaf(tree, targetId, newLeafId, direction, position);
}

// Atomic move: prune `sourceId` from the tree, then insert it at the given
// edge of `targetId`. No-op if source === target or source is not in the tree.
// Sharing one op between preview + commit guarantees preview and commit
// produce the same layout.
export function movePanel(
  tree: PanelNode,
  sourceId: string,
  targetId: string,
  direction: "horizontal" | "vertical",
  position: "before" | "after"
): PanelNode {
  if (sourceId === targetId) return tree;
  if (!getLeafIds(tree).includes(sourceId)) return tree;
  const pruned = closeLeaf(tree, sourceId);
  return insertAtEdge(pruned, targetId, sourceId, direction, position);
}
