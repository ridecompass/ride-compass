/** 空のループの検査（`vacuousLoops.test.ts`）が、確かめ（`expect`・`assert`）とループの形を読む構文の読み方。 */
import ts from "typescript";

const ASSERTION_ROOTS = new Set(["expect", "assert"]);
export function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return `${callee.expression.text}.${callee.name.text}`;
  }
  return "";
}

export function isAssertionCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  let root: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) root = root.expression;
  return ts.isIdentifier(root) && ASSERTION_ROOTS.has(root.text);
}

export const isFunctionLike = (node: ts.Node) =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);
export const isLoop = (node: ts.Node) =>
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isForStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

/** 入れ子の関数・ループへは入らずに、`node`の下を辿る。 */
export function forEachOwn(node: ts.Node, visit: (child: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    if (!isFunctionLike(child) && !isLoop(child)) forEachOwn(child, visit);
  });
}

export function containsAssertion(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (isAssertionCall(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** `expect(<subject>)[.not].<matcher>(<argument>)`を分解する。 */
export function matcherCall(
  node: ts.Node,
): { subject: ts.Expression; negated: boolean; matcher: string; argument?: ts.Expression } | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  let target = node.expression.expression;
  let negated = false;
  if (ts.isPropertyAccessExpression(target) && target.name.text === "not") {
    negated = true;
    target = target.expression;
  }
  if (!ts.isCallExpression(target) || calleeName(target) !== "expect" || target.arguments.length !== 1)
    return undefined;
  return {
    subject: unwrap(target.arguments[0]),
    negated,
    matcher: node.expression.name.text,
    argument: node.arguments[0],
  };
}
