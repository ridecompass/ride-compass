// 画面が backend の宣言を持ち直している形の候補を、構文木から列挙する（.claude/commands/review.md「構造の問い」の frontend の母集団）。
//
//   node scripts/structure-population.mjs [--axis-catalog <JSONのファイル>]
//
// 母集団は src の .ts・.tsx のうち、テスト（*.test.ts(x)）・テストの足場・生成物を除いたもの。足場と生成物の置き場、生成物が名前として
// 配る値の取り方は scripts/repo_population.json が持つ（鍵の意味は scripts/repo_population.py の docstring）。
// 出すのは候補で、判じない（偶然の一致・型で縛られた分岐が混ざる）。どれを直すかは読む人が決める。
//   (a) 文字列リテラル∩生成物の識別子: 式の中の文字列リテラルで、値が生成物の文字列の値（識別子の形のもの）と同じもの。
//       import の指定子・型の位置・オブジェクトの鍵の位置は除く。
//   (b) 画面の文∩本番の軸名・現象の語: 日本語を含む文字列・テンプレートの断片・JSX の文のうち、語を含むもの。語は生成物が
//       名前として配る値と、--axis-catalog で渡した軸カタログ（本番の backend の /api/axis-catalog の応答）の
//       軸の label。渡さなければ軸名は入らない。
//   (c) 重み・閾値の文脈の数値リテラル（関数の中を含む）: 0・1 を除く数値で、比べる式の片側・`||`／`??` の右・Math.min／max の引数か、
//       名前が重み・閾値・上下限を表す宣言・引数の既定・代入の値になっているもの。名前によらず、モジュールの上位の const の値の式
//       （算術の片側を含む。画面自身の定数）と、型が生成物で宣言された欄へ入れる値も入れる。
//   (d) 宣言の意味の鍵を名指す分岐: 文字列リテラルと、鍵を表す名前（key・id・kind 等）の値を比べる式・そうした値で分ける switch の case と、
//       値の並び（values・keys 等）が文字列・真偽の字句を含むかを見る `includes`。名前によらず、比べる相手・並びの要素の型が
//       生成物の文字列の値だけでできた字句の型（例: 軸カタログの `time_scope`）のものも入れる。
// 拾わない形（性質に当たりうるのに上の文脈に入らない。出力に0件でも無いとは言えず、使う人が別の grep か読んで見る）:
//   - 表示の桁の写し: `toFixed(n)`・`formatDelta(x, n)` 等の呼び出しの引数、`digits:` 等の欄の値、`Math.round` で整数へ丸める形。
//     (c) は比べる式・`||`／`??` の右・min／max の引数・限度を表す名前の値しか見ない。
//   - JSX の数値属性（`size={14}` 等）: (c) は JSX の属性の値を見ない。
//   - 関数の中の算術の片側（`x * 3.6`・`ms / 60_000`）と、限度を表さない名前の関数の中の宣言の値: (c) が名前によらず見るのは
//     モジュールの上位の const だけ。
//   - 型の外の比べ: (d) が型で見るのは字句の型の値が全部生成物にあるものだけで、`string` に広がった値（生成物の JSON を
//     import した値・手で書いた型）との比べは、鍵を表す名前のときだけ当たる。
//   - 言い換えの語: (b) は語の綴りとの一致だけを見るので、略称・同義語（例: 軸の名前を別の語で書いた文）は当たらない。
//   - 要求の形の述語: (d) は文字列の字句との比べだけを見るので、入力の欄の有無で分ける真偽の式
//     （例: `Boolean(generatedInput?.destination)`）は当たらない。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

import {
  EQUALITY,
  KEY_NAME,
  VALUE_LIST_NAME,
  isLiteralValue,
  isStringLike,
  isTypePosition,
  lastName,
  typedContexts,
} from "./structure-population/contexts.mjs";
import { readVocabulary, walk } from "./structure-population/vocabulary.mjs";

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(frontendRoot);
const srcRoot = path.join(frontendRoot, "src");
const tsconfigPath = path.join(frontendRoot, "tsconfig.json");
const population = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "repo_population.json"), "utf-8"));
const generatedRoot = path.resolve(repoRoot, population.generated);

const { values } = parseArgs({
  options: { "axis-catalog": { type: "string" } },
});

const EXCLUDED_DIRS = [...population.scaffold, population.generated].map(
  (dir) => path.resolve(repoRoot, dir) + path.sep,
);
const sources = walk(srcRoot).filter(
  (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !EXCLUDED_DIRS.some((dir) => file.startsWith(dir)),
);

// 型で見る (c)(d) のために、tsconfig の設定で型検査器を作る（生成物は import をたどって入る）。
const tsconfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(tsconfigPath, ts.sys.readFile).config,
  ts.sys,
  frontendRoot,
);
const program = ts.createProgram(sources, { ...tsconfig.options, incremental: false, noEmit: true });
const checker = program.getTypeChecker();

const JAPANESE = new RegExp(population.japanese);
const { generatedIdentifiers, generatedLiterals, words } = readVocabulary({
  generatedRoot,
  population,
  axisCatalog: values["axis-catalog"],
});
const { isGeneratedLiteralType, isGeneratedElements, numericContext } = typedContexts(
  checker,
  generatedRoot,
  generatedLiterals,
);

const found = { a: [], b: [], c: [], d: [] };

for (const file of sources) {
  const source = program.getSourceFile(file);
  const where = (node) =>
    `${path.relative(frontendRoot, file).replaceAll("\\", "/")}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const push = (kind, node, detail) => found[kind].push(`${where(node)}\t${detail}`);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) return;

    if (isStringLike(node) && !isTypePosition(node)) {
      const isKey =
        (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent)) && node.parent.name === node;
      if (!isKey && generatedIdentifiers.has(node.text)) push("a", node, JSON.stringify(node.text));
    }

    const phrase =
      isStringLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
        ? node.text
        : null;
    if (phrase && JAPANESE.test(phrase) && !isTypePosition(node)) {
      const hits = words.filter((word) => phrase.includes(word));
      if (hits.length > 0) push("b", node, `${hits.join("・")}\t${phrase.trim().slice(0, 60)}`);
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      const context = value === 0 || value === 1 ? null : numericContext(node);
      if (context) push("c", node, `${node.text}\t${context}\t${node.parent.getText(source).slice(0, 60)}`);
    }

    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const [literal, other] = isStringLike(node.left) ? [node.left, node.right] : [node.right, node.left];
      if (
        isStringLike(literal) &&
        (KEY_NAME.test(lastName(other) ?? "") || isGeneratedLiteralType(checker.getTypeAtLocation(other)))
      )
        push("d", node, node.getText(source).slice(0, 80));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments.length === 1 &&
      isLiteralValue(node.arguments[0]) &&
      (VALUE_LIST_NAME.test(lastName(node.expression.expression) ?? "") ||
        isGeneratedElements(node.expression.expression))
    ) {
      push("d", node, node.getText(source).slice(0, 80));
    }
    if (ts.isCaseClause(node) && isStringLike(node.expression)) {
      const switched = node.parent.parent.expression;
      if (KEY_NAME.test(lastName(switched) ?? "") || isGeneratedLiteralType(checker.getTypeAtLocation(switched)))
        push("d", node, `case ${node.expression.getText(source)}（${switched.getText(source)}）`);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

const LABELS = {
  a: "(a) 文字列リテラル∩生成物の識別子",
  b: "(b) 画面の文∩本番の軸名・現象の語",
  c: "(c) 重み・閾値の文脈の数値リテラル",
  d: "(d) 宣言の意味の鍵を名指す分岐",
};
for (const kind of Object.keys(found)) {
  console.log(
    `## ${LABELS[kind]}: ${found[kind].length}件${kind === "b" && !values["axis-catalog"] ? "（軸名なし: --axis-catalog を渡していない）" : ""}`,
  );
  for (const line of found[kind]) console.log(line);
}
