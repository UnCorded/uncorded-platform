import { describe, expect, test } from "bun:test";
import {
  type LeafNode,
  type PanelNode,
  type SplitNode,
  splitLeaf,
} from "./panel-layout";

const leaf = (id: string): LeafNode => ({ type: "leaf", id });

const hsplit = (first: PanelNode, second: PanelNode, ratio = 0.5): SplitNode => ({
  type: "split",
  id: "h",
  direction: "horizontal",
  ratio,
  first,
  second,
});

describe("splitLeaf — menu Split Down / Split Right", () => {
  // Regression: the menu's "Split Down" used to call splitLeafDown, which
  // walked up the tree to the nearest vertical-split ancestor (or root) and
  // wrapped there. With a horizontal-only layout this hoisted to root and
  // produced a full-width bottom row instead of splitting the source panel
  // in half. Menu actions split the target leaf in place.
  test("vertical split inside a horizontal split keeps the sibling untouched", () => {
    const tree = hsplit(leaf("voice"), leaf("text"));
    const next = splitLeaf(tree, "text", "vertical");

    if (next.type !== "split" || next.direction !== "horizontal") {
      throw new Error("root split direction must remain horizontal");
    }
    expect(next.first).toEqual(leaf("voice"));
    expect(next.second.type).toBe("split");
    const inner = next.second as SplitNode;
    expect(inner.direction).toBe("vertical");
    expect(inner.ratio).toBe(0.5);
    expect(inner.first).toEqual(leaf("text"));
    expect(inner.second.type).toBe("leaf");
    expect((inner.second as LeafNode).id).not.toBe("text");
  });

  test("horizontal split inside a vertical split keeps the sibling untouched", () => {
    const tree: SplitNode = {
      type: "split",
      id: "v",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("top"),
      second: leaf("bottom"),
    };
    const next = splitLeaf(tree, "bottom", "horizontal");

    if (next.type !== "split" || next.direction !== "vertical") {
      throw new Error("root split direction must remain vertical");
    }
    expect(next.first).toEqual(leaf("top"));
    const inner = next.second as SplitNode;
    expect(inner.type).toBe("split");
    expect(inner.direction).toBe("horizontal");
    expect(inner.first).toEqual(leaf("bottom"));
  });

  test("splitting a single-leaf root creates a 50/50 split with the leaf as `first`", () => {
    const next = splitLeaf(leaf("only"), "only", "vertical");
    expect(next.type).toBe("split");
    const split = next as SplitNode;
    expect(split.direction).toBe("vertical");
    expect(split.ratio).toBe(0.5);
    expect(split.first).toEqual(leaf("only"));
    expect((split.second as LeafNode).id).not.toBe("only");
  });

  test("unknown id is a no-op (returns structurally equal tree)", () => {
    const tree = hsplit(leaf("a"), leaf("b"));
    const next = splitLeaf(tree, "missing", "vertical");
    expect(next).toEqual(tree);
  });
});
