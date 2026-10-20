/** 共有の足場の写しの規則5（外部の境界の差し替えの写し）。 */
import ts from "typescript";

import { type Finding, MIN_COPIES, isScaffold, isTest, lineOf, type Source } from "./scaffoldSources";

/** `<対象>.<名前>(…)`の呼び出しか。 */
const isMethodCall = (node: ts.CallExpression, target: string, name: string) =>
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === target &&
  node.expression.name.text === name;

/**
 * 置き換える (対象.名前, 呼び出し): `Object.defineProperty(<対象>, "<名前>", …)`、`vi.stubGlobal("<名前>", …)`
 * （`globalThis.<名前>`）、`msw/node`の`setupServer(…)`（`globalThis.fetch`）。
 */
function replacedProperties(file: ts.SourceFile): { key: string; node: ts.Node }[] {
  const out: { key: string; node: ts.Node }[] = [];
  const msw = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "msw/node",
  );
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      if (isMethodCall(node, "Object", "defineProperty") && second && ts.isStringLiteralLike(second)) {
        out.push({ key: `${first.getText(file)}.${second.text}`, node });
      } else if (isMethodCall(node, "vi", "stubGlobal") && first && ts.isStringLiteralLike(first)) {
        out.push({ key: `globalThis.${first.text}`, node });
      } else if (msw && ts.isIdentifier(node.expression) && node.expression.text === "setupServer") {
        out.push({ key: "globalThis.fetch", node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

export function copiedBoundaries(sources: Source[]): Finding[] {
  const scaffolded = new Set(
    sources
      .filter(({ path }) => isScaffold(path))
      .flatMap(({ file }) => replacedProperties(file).map(({ key }) => key)),
  );
  const places = new Map<string, Map<string, Finding>>();
  for (const { path, file } of sources.filter(({ path }) => isTest(path) && !path.startsWith("src/testing/"))) {
    for (const { key, node } of replacedProperties(file)) {
      const files = places.get(key) ?? new Map<string, Finding>();
      if (!files.has(path)) files.set(path, { file: path, line: lineOf(file, node), reason: key });
      places.set(key, files);
    }
  }
  return [...places.entries()].flatMap(([key, files]) => {
    if (scaffolded.has(key)) return [...files.values()].map((found) => ({ ...found, reason: `${key}（足場がある）` }));
    return files.size >= MIN_COPIES
      ? [...files.values()].map((found) => ({ ...found, reason: `${key}（${files.size}ファイル）` }))
      : [];
  });
}
