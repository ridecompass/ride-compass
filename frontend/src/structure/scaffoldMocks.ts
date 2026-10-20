/** 共有の足場の写しの規則3（足場の代役の迂回）と4（自前のモジュールの差し替え）。 */
import ts from "typescript";

import { type Finding, isTest, lineOf, type Source, unwrap } from "./scaffoldSources";

function viMocks(file: ts.SourceFile): { specifier: string; factory: ts.Expression | undefined; node: ts.Node }[] {
  const out: { specifier: string; factory: ts.Expression | undefined; node: ts.Node }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "vi" &&
      node.expression.name.text === "mock" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push({ specifier: node.arguments[0].text, factory: node.arguments[1], node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** 差し替えの中身が返すオブジェクトが、部品の名前（`MapView`等。`MAX_ZOOM`等の定数でない大文字始まり）だけを置き換えるか。 */
function replacesOnlyComponents(factory: ts.Expression | undefined): boolean {
  if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) return false;
  let body: ts.Node = factory.body;
  if (ts.isBlock(body)) {
    const last = body.statements.at(-1);
    if (!last || !ts.isReturnStatement(last) || !last.expression) return false;
    body = last.expression;
  }
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) return false;
  const names = body.properties.flatMap((property) =>
    ts.isSpreadAssignment(property) ? [] : [property.name && ts.isIdentifier(property.name) ? property.name.text : ""],
  );
  return names.length > 0 && names.every((name) => /^[A-Z]/.test(name) && name !== name.toUpperCase());
}

/** `() => import("@/testing/…")`の形の差し替えなら、読む足場のパス（`src/testing/…`）。 */
function scaffoldImported(factory: ts.Expression | undefined): string | undefined {
  if (!factory || !ts.isArrowFunction(factory) || !ts.isExpression(factory.body)) return undefined;
  const body = unwrap(factory.body);
  return ts.isCallExpression(body) &&
    body.expression.kind === ts.SyntaxKind.ImportKeyword &&
    ts.isStringLiteral(body.arguments[0]) &&
    body.arguments[0].text.startsWith("@/testing/")
    ? `src/${body.arguments[0].text.slice(2)}`
    : undefined;
}

/** ファイルが`export`する名前（`export { A as B }`は`B`）。 */
function exportedNames(file: ts.SourceFile): string[] {
  return file.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.map((element) => element.name.text);
    }
    const named = statement as ts.Node & { name?: ts.Node };
    return ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      named.name &&
      ts.isIdentifier(named.name)
      ? [named.name.text]
      : [];
  });
}

export function bypassedStandIns(sources: Source[]): Finding[] {
  const byPath = new Map(sources.map((source) => [source.path, source.file]));
  const standIns = new Map<string, Set<string>>();
  for (const { file } of sources) {
    for (const { specifier, factory } of viMocks(file)) {
      const scaffold = byPath.get(`${scaffoldImported(factory)}.ts`);
      if (scaffold) standIns.set(specifier, new Set(exportedNames(scaffold)));
    }
  }
  const findings: Finding[] = [];
  for (const { path, file } of sources.filter(({ path }) => isTest(path) && !path.startsWith("src/testing/"))) {
    for (const { specifier, factory, node } of viMocks(file)) {
      if (standIns.has(specifier) && !scaffoldImported(factory)) {
        findings.push({ file: path, line: lineOf(file, node), reason: `vi.mock("${specifier}")` });
      }
    }
    const standInTypes = new Set(
      file.statements.flatMap((statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        standIns.has(statement.moduleSpecifier.text) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements
              .filter((element) =>
                standIns
                  .get((statement.moduleSpecifier as ts.StringLiteral).text)!
                  .has((element.propertyName ?? element.name).text),
              )
              .map((element) => element.name.text)
          : [],
      ),
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isAsExpression(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        standInTypes.has(node.type.typeName.text)
      ) {
        findings.push({ file: path, line: lineOf(file, node), reason: `as ${node.type.typeName.text}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return findings;
}

/** `from`（`src/…`のファイル）から`specifier`で指す`src`のモジュールのパス。`src`の外・パッケージは undefined。 */
function resolveOwn(from: string, specifier: string, paths: Set<string>): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) {
    const parts = from.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    base = parts.join("/");
  } else return undefined;
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((path) => paths.has(path));
}

export function ownModuleMocks(sources: Source[]): Finding[] {
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const paths = new Set(byPath.keys());
  const isBoundary = (path: string) => /process\.env\b|URL\.createObjectURL\b/.test(byPath.get(path)!.file.text);
  return sources
    .filter(({ path }) => isTest(path))
    .flatMap(({ path, file }) =>
      viMocks(file).flatMap(({ specifier, factory, node }) => {
        const target = resolveOwn(path, specifier, paths);
        return target && !isBoundary(target) && !replacesOnlyComponents(factory)
          ? [{ file: path, line: lineOf(file, node), reason: specifier }]
          : [];
      }),
    );
}
