// @vitest-environment node
/**
 * backend の要求の本文の型（`types/generated/openapi.json`の要求の本文から辿れる型。入れ子の型も含む）の任意の欄を、
 * 画面の本番のコードがその型の値として書く鍵と突き合わせ、どの書き手も書かない欄を落とす。backend の
 * `backend/tests/structure/test_silent_defaults.py`が型の中の作り手を見るのに対し、こちらは HTTP を挟んだ作り手（画面）を見る。
 *
 * 任意の欄は「送らない書き手がいる」ことの宣言で、どの書き手も送らない欄は、要求ごとに変えられる値として backend の
 * 既定値を束ね、出どころの無い値を後段へ流す。
 *
 * 母集団は`frontend/src`の`.ts(x)`のうち、テスト（`*.test.ts(x)`）・足場（`src/testing`）・この検査のディレクトリ・
 * 型の宣言（`.d.ts`）を除いたもの。型検査器で、生成された`components["schemas"][<名前>]`の型を文脈に持つ
 * オブジェクトリテラル（`T | null`の一員も含む）の鍵と、その型の値への`値.鍵 =`の代入の鍵を、その型の書き手として数える。
 *
 * 展開は、リテラルを展開する形（`...(条件 ? { 鍵: 値 } : {})`・`...(条件 && { 鍵: 値 })`）なら中の鍵を数え、
 * どの`return`でもリテラルを返す関数の呼び出しの展開（`...buildRequest(input)`）なら、その関数のリテラルを数えて読めるとする。
 *
 * **判定しない形**: それ以外の展開（`...x`）を持つリテラルが1つでもある型（どの鍵を書いたかが読めない）。書き手が1つも
 * 数えられない型（文脈の型の無いリテラル（`const body = {...}`）・`Partial<T>`等へ包んだ型・`as`で当てた値は数えない）。
 * 問い合わせの引数（`parameters`）と、`e2e`・`scripts`等の画面の外の書き手。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SRC_ROOT, removeTree, walkTree, writeTree } from "./sourceTree";

const OPENAPI = "types/generated/openapi.json";
const API_TYPES = "types/generated/api.d.ts";

type Schema = { properties?: Record<string, unknown>; required?: string[] };

const isProduction = (path: string) =>
  /\.tsx?$/.test(path) &&
  !/\.test\.tsx?$/.test(path) &&
  !path.endsWith(".d.ts") &&
  !path.startsWith("testing/") &&
  !path.startsWith("structure/");

/** 要求の本文から辿れる型の名前。 */
function requestSchemas(openapi: {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
}) {
  const refs = (value: unknown) =>
    (JSON.stringify(value).match(/#\/components\/schemas\/[^"]+/g) ?? []).map((ref) => ref.split("/").pop()!);
  const pending = Object.values(openapi.paths).flatMap((operations) =>
    Object.values(operations).flatMap((operation) =>
      refs((operation as { requestBody?: unknown }).requestBody ?? null),
    ),
  );
  const found = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (found.has(name)) continue;
    found.add(name);
    pending.push(...refs(openapi.components.schemas[name]));
  }
  return found;
}

function schemaTypes(checker: ts.TypeChecker, declarations: ts.SourceFile, names: Set<string>): Map<ts.Type, string> {
  const components = declarations.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "components",
  );
  if (!components) throw new Error(`${API_TYPES}に components が無い`);
  const schemas = checker.getTypeAtLocation(components.name).getProperty("schemas");
  if (!schemas) throw new Error(`${API_TYPES}の components に schemas が無い`);
  const schemasType = checker.getTypeOfSymbolAtLocation(schemas, components);
  const out = new Map<ts.Type, string>();
  for (const name of names) {
    const property = schemasType.getProperty(name);
    if (property) out.set(checker.getTypeOfSymbolAtLocation(property, components), name);
  }
  return out;
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

/** 呼んだ関数が、どの`return`でもオブジェクトリテラルを返すか（返すリテラルは、返り値の型の書き手に数える）。 */
function returnsLiterals(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !("body" in declaration) || !declaration.body) return false;
  const body = declaration.body as ts.Node;
  if (!ts.isBlock(body)) return ts.isObjectLiteralExpression(unwrap(body as ts.Expression));
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) returned.push(unwrap(node.expression));
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(body);
  return returned.length > 0 && returned.every(ts.isObjectLiteralExpression);
}

/**
 * リテラルの鍵を`keys`へ足す。リテラルの展開（`...(条件 ? { 鍵: 値 } : {})`）の鍵も足す。リテラルを返す関数の
 * 呼び出しの展開は、その関数のリテラルが書き手に数えられるので足さない。それ以外の展開を持てばfalse。
 */
function literalKeys(checker: ts.TypeChecker, literal: ts.ObjectLiteralExpression, keys: Set<string>): boolean {
  let readable = true;
  const spread = (expression: ts.Expression): boolean => {
    const inner = unwrap(expression);
    if (ts.isObjectLiteralExpression(inner)) return literalKeys(checker, inner, keys);
    if (ts.isCallExpression(inner)) return returnsLiterals(checker, inner);
    if (ts.isConditionalExpression(inner)) return spread(inner.whenTrue) && spread(inner.whenFalse);
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return spread(inner.right);
    return false;
  };
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) readable = spread(property.expression) && readable;
    else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      keys.add(property.name.text);
  }
  return readable;
}

/** どの書き手も書かない任意の欄（`<型>.<欄>`）。 */
export function unsentRequestFields(root: string): string[] {
  const openapi = JSON.parse(readFileSync(join(root, OPENAPI), "utf8"));
  const names = requestSchemas(openapi);
  const files = walkTree(root)
    .filter(({ path, isDirectory }) => !isDirectory && isProduction(path))
    .map(({ path }) => join(root, path));
  const program = ts.createProgram([...files, join(root, API_TYPES)], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2017,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    paths: { "@/*": [join(root, "*")] },
  });
  const checker = program.getTypeChecker();
  const types = schemaTypes(checker, program.getSourceFile(join(root, API_TYPES))!, names);
  const written = new Map<string, Set<string>>();
  const unjudged = new Set<string>();
  const schemaOf = (type: ts.Type | undefined) =>
    type === undefined ? [] : (type.isUnion() ? type.types : [type]).flatMap((t) => types.get(t) ?? []);

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const schema of schemaOf(checker.getContextualType(node))) {
        const keys = written.get(schema) ?? new Set<string>();
        written.set(schema, keys);
        if (!literalKeys(checker, node, keys)) unjudged.add(schema);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      for (const schema of schemaOf(checker.getNonNullableType(checker.getTypeAtLocation(node.left.expression)))) {
        const keys = written.get(schema) ?? new Set<string>();
        written.set(schema, keys);
        keys.add(node.left.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(program.getSourceFile(file)!);

  const out: string[] = [];
  for (const [schema, keys] of written) {
    if (unjudged.has(schema)) continue;
    const { properties = {}, required = [] } = openapi.components.schemas[schema] as Schema;
    for (const field of Object.keys(properties)) {
      if (!required.includes(field) && !keys.has(field)) out.push(`${schema}.${field}`);
    }
  }
  return out.sort();
}

describe("要求の本文の任意の欄", () => {
  it("どの欄も、画面の本番のコードのどれかが書く", () => {
    expect(unsentRequestFields(SRC_ROOT)).toEqual([]);
  }, 60_000);

  it("どの書き手も書かない欄を落とし、読めない展開で書く型と書き手の無い型は判定しない", () => {
    const schema = (properties: string[], required: string[] = []) => ({
      type: "object",
      properties: Object.fromEntries(properties.map((name) => [name, { type: "number" }])),
      required,
    });
    const body = (name: string) => ({
      requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } },
    });
    const root = writeTree({
      [OPENAPI]: JSON.stringify({
        paths: { "/a": { post: body("Request") }, "/b": { put: body("Spread") }, "/c": { post: body("Unwritten") } },
        components: {
          schemas: {
            Request: {
              ...schema(["distance_km", "speed", "tolerance", "nested"], ["distance_km"]),
              properties: {
                distance_km: {},
                speed: {},
                tolerance: {},
                nested: { $ref: "#/components/schemas/Nested" },
              },
            },
            Nested: schema(["weight", "label"]),
            Spread: schema(["a", "b"]),
            Unwritten: schema(["c"]),
            Response: schema(["d"]),
          },
        },
      }),
      [API_TYPES]: [
        "export interface components {",
        "  schemas: {",
        "    Request: { distance_km: number; speed?: number | null; tolerance?: number | null; nested?: components['schemas']['Nested'] | null };",
        "    Nested: { weight?: number; label?: string };",
        "    Spread: { a?: number; b?: number };",
        "    Unwritten: { c?: number };",
        "    Response: { d?: number };",
        "  };",
        "}",
      ].join("\n"),
      "types/route.ts": [
        'import type { components } from "@/types/generated/api";',
        'export type Request = components["schemas"]["Request"];',
        'export type Spread = components["schemas"]["Spread"];',
        'export type Response = components["schemas"]["Response"];',
      ].join("\n"),
      "features/api.ts": [
        'import type { Request, Spread, Response } from "@/types/route";',
        "declare function send(body: Request | null): void;",
        "export function build(spread: Spread): Spread {",
        "  send({ distance_km: 1, ...(spread.a ? { nested: { weight: 2 } } : {}) });",
        "  const request: Request = { distance_km: 2 };",
        "  request.speed = 3;",
        "  const response: Response = {};",
        "  void response;",
        "  return { ...spread, a: 1 };",
        "}",
        "function base(): Request {",
        "  return { distance_km: 1 };",
        "}",
        "export const again: Request = { ...base(), speed: 1 };",
      ].join("\n"),
      "features/api.test.ts": [
        'import type { Request } from "@/types/route";',
        "export const sent: Request = { distance_km: 1, tolerance: 1 };",
      ].join("\n"),
    });
    try {
      expect(unsentRequestFields(root)).toEqual(["Nested.label", "Request.tolerance"]);
    } finally {
      removeTree(root);
    }
  });
});
