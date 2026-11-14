/** 共有の足場の写しの規則5（外部の境界の差し替えの写し）。 */
import ts from "typescript";

import { type Finding, MIN_COPIES, isScaffold, isTest, lineOf, type Source, unwrap } from "./scaffoldSources";

/** `<対象>.<名前>(…)`の呼び出しか。 */
const isMethodCall = (node: ts.CallExpression, target: string, name: string) =>
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === target &&
  node.expression.name.text === name;

/** 名前を作る宣言（変数・引数・関数・クラス・import）か。 */
const declares = (node: ts.Node) =>
  ts.isVariableDeclaration(node) ||
  ts.isParameter(node) ||
  ts.isBindingElement(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isImportClause(node) ||
  ts.isImportSpecifier(node) ||
  ts.isNamespaceImport(node) ||
  ts.isImportEqualsDeclaration(node);

/**
 * 外部の境界の名前への代入の (対象.名前, 代入): ファイルの中で宣言されていない名前（`globalThis`・`window`・`navigator`等）か、
 * それを型を当てて受けた変数（`const holder = globalThis as …`）の項目へ代入する形。対象は別名を外した大域の名前で数える。
 */
function assignedGlobals(file: ts.SourceFile): { key: string; node: ts.Node }[] {
  const declared = new Set<string>();
  const aliases = new Map<string, string>();
  const collect = (node: ts.Node) => {
    const name = declares(node) ? ts.getNameOfDeclaration(node as ts.Declaration) : undefined;
    if (name && ts.isIdentifier(name)) declared.add(name.text);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const alias = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isIdentifier(value) && !declared.has(value.text)) aliases.set(node.name.text, value.text);
    }
    ts.forEachChild(node, alias);
  };
  alias(file);
  const globalOf = (node: ts.Expression) => {
    const target = unwrap(node);
    if (!ts.isIdentifier(target)) return null;
    return aliases.get(target.text) ?? (declared.has(target.text) ? null : target.text);
  };
  const out: { key: string; node: ts.Node }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const target = globalOf(node.left.expression);
      if (target) out.push({ key: `${target}.${node.left.name.text}`, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * 置き換える (対象.名前, 呼び出し): `Object.defineProperty(<対象>, "<名前>", …)`、`vi.stubGlobal("<名前>", …)`
 * （`globalThis.<名前>`）、`msw/node`の`setupServer(…)`（`globalThis.fetch`）と、外部の境界の名前への代入。
 */
function replacedProperties(file: ts.SourceFile): { key: string; node: ts.Node }[] {
  const out = assignedGlobals(file);
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
