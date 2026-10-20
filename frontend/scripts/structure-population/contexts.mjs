// 列挙の (c)(d) が、字句の置かれた文脈を読む判定（scripts/structure-population.mjs が使う）。

import path from "node:path";
import ts from "typescript";

export const KEY_NAME =
  /^(key|id|kind|role|source|group|property|level|type|tier|category|layerId|axisId|attrId)$|(Id|Key|_id|_key|_kind)$/;
const LIMIT_NAME = /weight|threshold|min|max|limit|ratio|share|bound|floor|ceil|cap|tolerance|eps|default/i;
export const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const COMPARISON = new Set([
  ...EQUALITY,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
/** 宣言の値の並び（行の`values`・鍵の並び）の名前。 */
export const VALUE_LIST_NAME = /(values|keys|ids|kinds)$/i;

/** 式の最後の名前（`a.b.key` なら key、`x` なら x、`a["key"]` なら key）。 */
export function lastName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
    return node.argumentExpression.text;
  if (
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return lastName(node.expression);
  return null;
}

export function isTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
}

export function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

export function isLiteralValue(node) {
  return isStringLike(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
}

/** モジュールの上位の const の値の式の中か（算術・括弧・並び・オブジェクトの値をたどる。関数の中は数えない）。 */
function isTopLevelConstValue(node) {
  let current = node;
  while (
    ts.isBinaryExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent) ||
    ts.isPrefixUnaryExpression(current.parent) ||
    ts.isArrayLiteralExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) ||
    ts.isObjectLiteralExpression(current.parent)
  )
    current = current.parent;
  const declaration = current.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === current &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

/**
 * 型検査器で読む判定。`generatedRoot` は生成物の置き場、`generatedLiterals` は生成物の文字列の値
 * （./vocabulary.mjs: readVocabulary の `generatedLiterals`）。
 */
export function typedContexts(checker, generatedRoot, generatedLiterals) {
  const isGeneratedFile = (file) => path.resolve(file).startsWith(generatedRoot + path.sep);

  /** 型が、生成物の文字列の値だけでできた字句の型か（undefined・null は除いて見る）。 */
  function isGeneratedLiteralType(type) {
    const members = (type.isUnion() ? type.types : [type]).filter(
      (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    return (
      members.length > 0 && members.every((member) => member.isStringLiteral() && generatedLiterals.has(member.value))
    );
  }

  /** 並びの型の要素の型（並びでなければ null）。 */
  function elementType(type) {
    const nonNull = checker.getNonNullableType(type);
    return checker.isArrayType(nonNull) || checker.isTupleType(nonNull)
      ? (checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number) ?? null)
      : null;
  }

  /** 並びの要素の型が、生成物の文字列の値だけでできた字句の型か。 */
  function isGeneratedElements(expression) {
    const element = elementType(checker.getTypeAtLocation(expression));
    return element !== null && isGeneratedLiteralType(element);
  }

  /** オブジェクトの欄が、型の上で生成物の宣言の欄か。 */
  function isGeneratedProperty(assignment) {
    const contextual = checker.getContextualType(assignment.parent);
    const property = contextual && checker.getPropertyOfType(contextual, assignment.name.getText().replaceAll('"', ""));
    return (property?.declarations ?? []).some((declaration) => isGeneratedFile(declaration.getSourceFile().fileName));
  }

  /** 数値リテラルが置かれた文脈（(c) に当たらなければ null）。 */
  function numericContext(literal) {
    let node = literal;
    if (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.MinusToken)
      node = node.parent;
    const parent = node.parent;
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (COMPARISON.has(op)) return "比べる式";
      if ((op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) && parent.right === node)
        return "既定の値";
      if (op === ts.SyntaxKind.EqualsToken && LIMIT_NAME.test(lastName(parent.left) ?? "")) return "名前の付いた値";
    }
    if (ts.isCallExpression(parent) && /^(min|max|clamp)$/i.test(lastName(parent.expression) ?? ""))
      return "上下限の引数";
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent)) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      LIMIT_NAME.test(parent.name.text)
    )
      return "名前の付いた値";
    if (ts.isPropertyAssignment(parent) && parent.initializer === node && LIMIT_NAME.test(parent.name.getText()))
      return "名前の付いた値";
    if (ts.isPropertyAssignment(parent) && parent.initializer === node && isGeneratedProperty(parent))
      return "生成物の欄の値";
    if (isTopLevelConstValue(node)) return "画面自身の定数";
    return null;
  }

  return { isGeneratedLiteralType, isGeneratedElements, numericContext };
}
