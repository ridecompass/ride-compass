/** 共有の足場の写しの規則1（最上位の定義の写し）と2（組み立て関数の迂回）。 */
import ts from "typescript";

import { type Finding, MIN_COPIES, isScaffold, isTest, lineOf, printer, type Source, unwrap } from "./scaffoldSources";

const MIN_VALUE_LEAVES = 5;

function leaves(node: ts.Node): number {
  let count = ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node) ? 1 : 0;
  ts.forEachChild(node, (child) => {
    count += leaves(child);
  });
  return count;
}

/** 最上位の定義の (名前, 行, 本体の形)。 */
function definitions({ file }: Source): { name: string; line: number; shape: string }[] {
  const out: { name: string; line: number; shape: string }[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const shape = [...statement.parameters, statement.type, statement.body]
        .map((node) => (node ? printer.printNode(ts.EmitHint.Unspecified, node, file) : ""))
        .join("|");
      out.push({ name: statement.name.text, line: lineOf(file, statement), shape });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = unwrap(declaration.initializer);
        const isFunction = ts.isArrowFunction(value) || ts.isFunctionExpression(value);
        if (!isFunction && leaves(value) < MIN_VALUE_LEAVES) continue;
        out.push({
          name: declaration.name.text,
          line: lineOf(file, declaration),
          shape: printer.printNode(ts.EmitHint.Expression, declaration.initializer, file),
        });
      }
    }
  }
  return out;
}

export function copiedDefinitions(sources: Source[]): Finding[] {
  const places = new Map<string, Map<string, Finding>>();
  for (const source of sources.filter(({ path }) => isTest(path) || isScaffold(path))) {
    for (const { name, line, shape } of definitions(source)) {
      const files = places.get(shape) ?? new Map<string, Finding>();
      if (!files.has(source.path)) files.set(source.path, { file: source.path, line, reason: name });
      places.set(shape, files);
    }
  }
  return [...places.values()]
    .filter((files) => files.size >= MIN_COPIES)
    .flatMap((files) =>
      [...files.values()].map((found) => ({ ...found, reason: `${found.reason}（${files.size}ファイル）` })),
    );
}

function propertyNames(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((property) =>
    (ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? [property.name.text]
      : [],
  );
}

/** `src/testing`の公開の組み立て関数（返すリテラルが展開を持つもの）の名前と、返すリテラルの項目。 */
function builders(sources: Source[]): { name: string; keys: string[] }[] {
  return sources
    .filter(({ path }) => isScaffold(path))
    .flatMap(({ file }) =>
      file.statements.flatMap((statement) => {
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) return [];
        if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
        const returned = statement.body.statements.find(ts.isReturnStatement)?.expression;
        const literal = returned && unwrap(returned);
        return literal && ts.isObjectLiteralExpression(literal) && literal.properties.some(ts.isSpreadAssignment)
          ? [{ name: statement.name.text, keys: propertyNames(literal) }]
          : [];
      }),
    );
}

export function bypassedBuilders(sources: Source[]): Finding[] {
  const known = builders(sources).filter(({ keys }) => keys.length > 0);
  const findings: Finding[] = [];
  for (const { path, file } of sources.filter(({ path }) => isTest(path) && !path.startsWith("src/testing/"))) {
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(propertyNames(node));
        for (const { name, keys } of known) {
          if (keys.every((key) => names.has(key)))
            findings.push({ file: path, line: lineOf(file, node), reason: name });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return findings;
}
