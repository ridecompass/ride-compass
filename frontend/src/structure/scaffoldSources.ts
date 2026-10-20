/** 共有の足場の写しの検査（`scaffoldCopies.test.ts`）が読む母集団と、規則の間で共有する構文の読み方。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { walkTree } from "./sourceTree";

/** 写しを落とす数（共有の足場へ出すのは3箇所目から）。 */
export const MIN_COPIES = 3;

export type Source = { path: string; file: ts.SourceFile };
export type Finding = { file: string; line: number; reason: string };

export const isTest = (path: string) => /\.test\.tsx?$/.test(path) || path.startsWith("e2e/");
export const isScaffold = (path: string) => path.startsWith("src/testing/") && !/\.test\.tsx?$/.test(path);

export function readSources(root: string): Source[] {
  const paths = ["src", "e2e"].flatMap((top) =>
    existsSync(join(root, top))
      ? walkTree(join(root, top))
          .filter(({ path, isDirectory }) => !isDirectory && /\.tsx?$/.test(path) && !path.startsWith("structure/"))
          .map(({ path }) => `${top}/${path}`)
      : [],
  );
  return paths.map((path) => ({
    path,
    file: ts.createSourceFile(
      path,
      readFileSync(join(root, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }));
}

export const printer = ts.createPrinter({ removeComments: true });
export const lineOf = (file: ts.SourceFile, node: ts.Node) =>
  file.getLineAndCharacterOfPosition(node.getStart()).line + 1;

export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}
