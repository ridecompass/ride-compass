// @vitest-environment node
/**
 * 道の値の式の木（軸カタログの`way_value_formula`）を地図の式へ置き換える所が、`features/map/scene/wayValueFormula.ts`の
 * 1つだけであることを見る。置き換えが2か所にあると、片方だけが木の値の約束（丸め・欠けた値）から外れても表
 * （`scene/wayValueFormula.test.ts`）では落ちず、同じ道が地図の場所によって backend と違う色になる。
 *
 * 母集団は`frontend/src`の`*.test.ts(x)`でない`.ts(x)`（テストの足場`src/testing`・生成物`src/types/generated`・この検査の
 * ディレクトリを除く）で、TypeScriptの構文木で読む。違反は、置き換える所の外で節の種類の名前`op`を読み書きすること——
 * 属性として読む（`node.op`・`node["op"]`）、分割代入で取り出す（`{ op }`）、オブジェクトに書く（`{ op: "add" }`）。
 *
 * **判定しない形**: 木を開かずに運ぶだけの型の名指し（`components["schemas"]["WayValueFormula"]`）。`op`以外の名前で
 * 節の種類を読む形。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { SRC_ROOT, removeTree, walkTree, writeTree } from "./sourceTree";

const CONVERSION = "features/map/scene/wayValueFormula.ts";
const SKIPPED_DIRECTORIES = ["testing/", "types/generated/", "structure/"];

function isProduction(path: string): boolean {
  return (
    /\.tsx?$/.test(path) &&
    !/\.test\.tsx?$/.test(path) &&
    !SKIPPED_DIRECTORIES.some((directory) => path.startsWith(directory))
  );
}

/** 節の種類の名前を読み書きする所（`op`の属性・分割代入・オブジェクトの項目）。 */
function readsOp(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "op";
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "op";
  }
  if (ts.isBindingElement(node)) {
    const name = node.propertyName ?? node.name;
    return ts.isIdentifier(name) && name.text === "op";
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "op";
  }
  return false;
}

/** `root`の下で、置き換える所の外で`op`を読み書きするファイルと、置き換える所が読むか。 */
function scan(root: string): { outside: string[]; conversionReads: boolean } {
  const files = walkTree(root).filter((entry) => !entry.isDirectory && isProduction(entry.path));
  const reading = files
    .filter(({ path }) => {
      const file = ts.createSourceFile(path, readFileSync(join(root, path), "utf-8"), ts.ScriptTarget.Latest, true);
      let found = false;
      const visit = (node: ts.Node) => {
        if (readsOp(node)) found = true;
        if (!found) ts.forEachChild(node, visit);
      };
      visit(file);
      return found;
    })
    .map(({ path }) => path);
  return {
    outside: reading.filter((path) => path !== CONVERSION),
    conversionReads: reading.includes(CONVERSION),
  };
}

describe("式の木を地図の式へ置き換える所", () => {
  it("節の種類を読み書きするのは、置き換える所だけ", () => {
    const { outside, conversionReads } = scan(SRC_ROOT);

    // 置き換える所を読めていなければ、この検査は何も見ていない。
    expect(conversionReads).toBe(true);
    expect(outside).toEqual([]);
  });

  describe("わざと壊した木", () => {
    let root: string;
    afterEach(() => removeTree(root));

    it.each([
      ["属性で読む", "export const kind = (node: { op: string }) => node.op;"],
      ["添字で読む", 'export const kind = (node: Record<string, string>) => node["op"];'],
      ["分割代入で取り出す", "export const kind = ({ op }: { op: string }) => op;"],
      ["節を組む", 'export const node = { op: "add" };'],
    ])("置き換える所の外で%sと落ちる", (_, source) => {
      root = writeTree({ [CONVERSION]: "export const op = 1;", "lib/other.ts": source });

      expect(scan(root).outside).toEqual(["lib/other.ts"]);
    });

    it("テスト・足場・生成物は数えない", () => {
      const source = 'export const node = { op: "add" };';
      root = writeTree({
        "lib/other.test.ts": source,
        "testing/formula.ts": source,
        "types/generated/api.ts": source,
      });

      expect(scan(root).outside).toEqual([]);
    });
  });
});
