/**
 * 要素ごとに確かめるテストが、母集団が空のとき何も確かめずに通る形になっていないかを見る
 * （規約は .claude/rules/testing-structure.md パターン6。backend の同じ検査は
 * `backend/tests/structure/test_vacuous_loops.py`）。
 *
 * 母集団は`frontend/src`配下の全`*.test.ts(x)`で、TypeScriptの構文木で読む。
 *
 * 要素ごとの確かめ:
 * - 本体に`expect(...)`・`assert(...)`がある`for...of`・`for...in`・`.forEach(...)`
 * - 空なら真になる量化（`expect(xs.every(...)).toBe(true)`・`expect(xs.some(...)).toBe(false)`と、
 *   `toBeTruthy`・`toBeFalsy`・`.not`で同じ意味になるもの）
 *
 * 違反（どれか1つ）:
 * 1. 反復対象がその場で`.filter(...)`を経ている（絞った後の母集団に名前が無く、空でないことを主張できない）
 * 2. ループ本体の条件を通らないと確かめに届かない——片側にだけ確かめがある`if`・三項・`catch`・
 *    `&&`/`||`/`??`の右側、または本体の`continue`・`break`・`return`（入れ子の関数の中のものは除く）
 * 3. 反復対象の名前が`.filter(...)`で束ねられていて、同じ関数（テストのコールバック）に、その名前か、
 *    件数を変えずにそれを写した名前が空でないことの主張が無い。主張として読む形:
 *    `expect(xs).toHaveLength(n)`（n>0）・`expect(xs).not.toHaveLength(0)`・
 *    `expect(xs.length).toBeGreaterThan(n)`（n>=0）・`toBeGreaterThanOrEqual(n)`（n>=1）・`toBe(n)`（n>0）・
 *    `.not.toBe(0)`・空でない配列のリテラルとの等値`expect(xs).toEqual([...])`（`toStrictEqual`も。
 *    等値の側の件数を変えない写しは剥がして読む）
 *
 * 件数を変えない写し（`.map`・`.sort`・`.toSorted`・`.reverse`・`.entries()`等・`Object.entries/values/keys`・
 * `Array.from`・`[...xs]`）は剥がして読み、名前は引数の無い呼び出し（`xs()`）も含めて、外側の
 * スコープの`const`/`let`/`function`宣言へ辿る。
 *
 * 見ないもの: 反復対象が関数の引数のループ（母集団は呼び出し側が決める）。量化のコールバックの中の
 * 条件（`xs.every((x) => !cond || ok)`）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { containsAssertion, forEachOwn, isAssertionCall, isFunctionLike, isLoop, matcherCall } from "./assertionSyntax";
import { enclosingFunction, filteredNames, hasNonEmptyAssertion, strip } from "./filteredPopulation";
import { walkTree } from "./sourceTree";

type Finding = { file: string; line: number; reason: string };

export const FILTERED_HERE = "反復対象がその場で絞り込まれている";
export const GATED = "本体の条件を通らないと確かめに届かない";
export const NOT_ASSERTED = "絞り込んだ名前が空でないことの主張が同じ関数に無い";

/** 確かめから本体まで遡り、片側にだけ確かめのある分岐を経るか。入れ子の関数・ループに入っていれば、その確かめは数えない。 */
function gatedOnOneSide(assertion: ts.Node, body: ts.Node): boolean {
  let child = assertion;
  for (let node = assertion.parent; node && node !== body; child = node, node = node.parent) {
    if (isFunctionLike(node) || isLoop(node)) return false;
    if (ts.isIfStatement(node) && child !== node.expression) {
      const other = child === node.thenStatement ? node.elseStatement : node.thenStatement;
      if (!other || !containsAssertion(other)) return true;
    }
    if (ts.isConditionalExpression(node) && child !== node.condition) {
      if (!containsAssertion(child === node.whenTrue ? node.whenFalse : node.whenTrue)) return true;
    }
    if (ts.isCatchClause(node)) return true;
    if (ts.isBinaryExpression(node) && child === node.right) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return true;
      }
    }
  }
  return false;
}

function isGated(body: ts.Node): boolean {
  let gated = false;
  const visit = (node: ts.Node) => {
    if (ts.isContinueStatement(node) || ts.isBreakStatement(node) || ts.isReturnStatement(node)) gated = true;
    if (isAssertionCall(node) && gatedOnOneSide(node, body)) gated = true;
  };
  visit(body);
  forEachOwn(body, visit);
  return gated;
}

/** 真偽値を主張する matcher なら、主張した値（`.not`の前）。 */
function assertedTruth(matcher: string, argument: ts.Expression | undefined): boolean | undefined {
  if (matcher === "toBeTruthy") return true;
  if (matcher === "toBeFalsy") return false;
  if (!["toBe", "toEqual", "toStrictEqual"].includes(matcher) || !argument) return undefined;
  if (argument.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (argument.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

type ElementCheck = { iterable: ts.Expression; body?: ts.Node };

function elementCheck(node: ts.Node): ElementCheck | undefined {
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && containsAssertion(node.statement)) {
    return { iterable: node.expression, body: node.statement };
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "forEach"
  ) {
    const callback = node.arguments[0];
    if (
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      containsAssertion(callback.body)
    ) {
      return { iterable: node.expression.expression, body: callback.body };
    }
  }
  const call = matcherCall(node);
  if (!call || !ts.isCallExpression(call.subject) || !ts.isPropertyAccessExpression(call.subject.expression))
    return undefined;
  const quantifier = call.subject.expression.name.text;
  const truthy = assertedTruth(call.matcher, call.argument);
  if ((quantifier !== "every" && quantifier !== "some") || truthy === undefined) return undefined;
  // 空の配列では every が真・some が偽になるので、その向きを主張していれば空で素通りする
  if ((quantifier === "every") === (truthy !== call.negated)) {
    return { iterable: call.subject.expression.expression };
  }
  return undefined;
}

export function findVacuousLoops(file: string, text: string): Finding[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const report = (node: ts.Node, reason: string) =>
    findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, reason });
  const visit = (node: ts.Node) => {
    const check = elementCheck(node);
    if (check) {
      if (strip(check.iterable).filtered) report(node, FILTERED_HERE);
      else {
        const names = filteredNames(check.iterable, node);
        if (names && !hasNonEmptyAssertion(enclosingFunction(node), names)) report(node, NOT_ASSERTED);
      }
      if (check.body && isGated(check.body)) report(node, GATED);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

export function findInTree(root: string): { files: string[]; findings: Finding[] } {
  const files = walkTree(root)
    .map(({ path }) => path)
    .filter((path) => /\.test\.tsx?$/.test(path));
  return { files, findings: files.flatMap((file) => findVacuousLoops(file, readFileSync(join(root, file), "utf8"))) };
}
