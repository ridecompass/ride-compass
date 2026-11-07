/** 空のループの検査（`vacuousLoops.test.ts`）の、反復対象を宣言へ辿る読み方と、空でないことの主張の読み方。 */
import ts from "typescript";

import { calleeName, isFunctionLike, matcherCall, unwrap } from "./assertionSyntax";

const SAME_COUNT_METHODS = new Set(["map", "sort", "toSorted", "reverse", "toReversed", "entries", "values", "keys"]);
const SAME_COUNT_FUNCTIONS = new Set(["Object.entries", "Object.values", "Object.keys", "Array.from"]);

/** 反復対象を、件数を変えない写しを剥がしながら辿る。途中に`.filter`があれば`filtered`。 */
export function strip(expression: ts.Expression): { base: ts.Expression; filtered: boolean } {
  let current = unwrap(expression);
  for (;;) {
    if (
      ts.isArrayLiteralExpression(current) &&
      current.elements.length === 1 &&
      ts.isSpreadElement(current.elements[0])
    ) {
      current = unwrap(current.elements[0].expression);
    } else if (
      ts.isCallExpression(current) &&
      SAME_COUNT_FUNCTIONS.has(calleeName(current)) &&
      current.arguments.length > 0
    ) {
      current = unwrap(current.arguments[0]);
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text;
      if (method === "filter") return { base: current, filtered: true };
      if (!SAME_COUNT_METHODS.has(method)) return { base: current, filtered: false };
      current = unwrap(current.expression.expression);
    } else {
      return { base: current, filtered: false };
    }
  }
}

/** `xs`・`xs()`の名前。 */
function referencedName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression) && expression.arguments.length === 0 && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return undefined;
}

/** `from`から外側へ、`name`を宣言した式（関数なら返す式）を探す。 */
function declaredValue(name: string, from: ts.Node): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : undefined;
    for (const statement of statements ?? []) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
            return returnedValue(unwrap(declaration.initializer));
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
        return singleReturn(statement.body);
      }
    }
  }
  return undefined;
}

function returnedValue(expression: ts.Expression): ts.Expression | undefined {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return expression;
  return ts.isBlock(expression.body) ? singleReturn(expression.body) : expression.body;
}

function singleReturn(body: ts.Block): ts.Expression | undefined {
  const returns = body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0].expression : undefined;
}

/** 反復対象の名前を宣言へ辿り、`.filter`で束ねられていれば、その途中の名前を全部返す。 */
export function filteredNames(iterable: ts.Expression, at: ts.Node): string[] | undefined {
  const names: string[] = [];
  let expression: ts.Expression | undefined = iterable;
  while (expression) {
    const { base, filtered } = strip(expression);
    if (filtered) return names;
    const name = referencedName(base);
    if (!name || names.includes(name)) return undefined;
    names.push(name);
    expression = declaredValue(name, at);
  }
  return undefined;
}

function numberLiteral(node: ts.Expression | undefined): number | undefined {
  return node && ts.isNumericLiteral(unwrap(node)) ? Number((unwrap(node) as ts.NumericLiteral).text) : undefined;
}

function isNonEmptyArrayLiteral(node: ts.Expression | undefined): boolean {
  return (
    node !== undefined &&
    ts.isArrayLiteralExpression(unwrap(node)) &&
    (unwrap(node) as ts.ArrayLiteralExpression).elements.some((element) => !ts.isSpreadElement(element))
  );
}

function assertsNonEmpty(node: ts.Node, names: readonly string[]): boolean {
  const call = matcherCall(node);
  if (!call) return false;
  const { subject, negated, matcher } = call;
  const named = (expression: ts.Expression) => {
    const name = referencedName(unwrap(expression));
    return name !== undefined && names.includes(name);
  };
  if (!negated && (matcher === "toEqual" || matcher === "toStrictEqual") && isNonEmptyArrayLiteral(call.argument)) {
    const { base, filtered } = strip(subject);
    return !filtered && named(base);
  }
  const n = numberLiteral(call.argument);
  if (n === undefined) return false;
  if (named(subject) && matcher === "toHaveLength") return negated ? n === 0 : n > 0;
  if (!ts.isPropertyAccessExpression(subject) || subject.name.text !== "length" || !named(subject.expression))
    return false;
  if (negated) return matcher === "toBe" && n === 0;
  if (matcher === "toBeGreaterThan") return n >= 0;
  if (matcher === "toBeGreaterThanOrEqual") return n >= 1;
  return matcher === "toBe" && n > 0;
}

export function enclosingFunction(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

export function hasNonEmptyAssertion(scope: ts.Node, names: readonly string[]): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (assertsNonEmpty(node, names)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}
