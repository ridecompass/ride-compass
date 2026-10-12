// 本ごとに分けて回した Stryker の結果（mutation.json）を1つの表にする。frontend の下で、測った版と同じ版のチェックアウトで打つ
// （テストの場所・層の並びを、ここから読む）。
// 引数: 成果物を取ってきた場所（本ごとのディレクトリの下に mutation.json がある所） 書き出すファイル
//
// 表の形は Stryker の結果の JSON（mutation-testing-elements の report schema の版2）のままで、backend の表と同じ台本
// （backend/scripts/mutation/review.py）が読む。Stryker の出したものから変えるのは次だけ。
// - テストの id: 本ごとに振られた番号を、ファイルとテストの名前ごとに1つの番号へ振り直す。
// - 書き換えの id: Stryker は本ごとに0から振るので、表の全体で1つずつの番号へ振り直す。
// - テストの場所: vitest の口は出さないので、vitest のテストの一覧（場所つき）と構文木から、テストを定義した呼び出しの始めと
//   終わりの行を入れる（終わりは、その次の行）。見つからないテストは場所を持たない（前回との比べから外れる）。
// - テストが1本も走らずに Survived とされた書き換え（testsCompleted が 0。stryker-mutator/stryker-js#6213）は、生き残りでは
//   なく測れなかったものとして RuntimeError にし、statusReason に理由を書く。
// - config.revision（測った版）と config.layers（層の並び。上から。eslint.config.mjs: LAYERS）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { LAYERS } from "../../eslint.config.mjs";

const [ART, OUT] = process.argv.slice(2);
const ZERO_TESTS = "テストが1本も走らなかった（測れていない。stryker-mutator/stryker-js#6213）";

const shards = readdirSync(ART, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(ART, d.name, "mutation.json")))
  .map((d) => JSON.parse(readFileSync(path.join(ART, d.name, "mutation.json"), "utf-8")));
if (shards.length === 0) throw new Error(`${ART} に mutation.json が無い`);

const testIds = new Map(); // `${ファイル}::${名前}` → 振り直した id
const tests = new Map(); // ファイル → [{ id, name }]
const files = {};
let zeroTests = 0;
let mutantCount = 0;
for (const report of shards) {
  const local = new Map();
  for (const [file, { tests: defs }] of Object.entries(report.testFiles ?? {})) {
    for (const def of defs) {
      const key = `${file}::${def.name}`;
      if (!testIds.has(key)) {
        testIds.set(key, String(testIds.size));
        if (!tests.has(file)) tests.set(file, []);
        tests.get(file).push({ id: testIds.get(key), name: def.name });
      }
      local.set(def.id, testIds.get(key));
    }
  }
  const remap = (ids) => ids?.map((id) => local.get(id));
  for (const [file, entry] of Object.entries(report.files)) {
    files[file] = {
      ...entry,
      mutants: entry.mutants.map((m) => {
        const out = { ...m, id: String(mutantCount++), killedBy: remap(m.killedBy), coveredBy: remap(m.coveredBy) };
        if (m.status === "Survived" && m.testsCompleted === 0 && m.coveredBy?.length) {
          out.status = "RuntimeError";
          out.statusReason = ZERO_TESTS;
          zeroTests += 1;
        }
        return out;
      }),
    };
  }
}

// vitest の一覧の名前は it.each の %s・$name を埋めないので、そこを何にでも合う形にして、実行したテストの名前に当てる
// （$ の後ろの名前の読み方は vitest と同じ。日本語も名前に続けて読む）。
function namePattern(name) {
  const parts = name.split(/(%[sdifjoc#$%]|\$[$\p{ID_Continue}.]+)/u);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${parts.map((part, i) => (i % 2 ? ".*?" : escape(part))).join("")}$`, "u");
}

// テストを定義した呼び出し（it(…)・test.each(…)(…) 等）のうち、位置を含むいちばん外のもの。
function isTestCall(node) {
  let callee = node.expression;
  while (callee) {
    if (ts.isIdentifier(callee)) return callee.text === "it" || callee.text === "test";
    if (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
    else if (ts.isCallExpression(callee)) callee = callee.expression;
    else if (ts.isTaggedTemplateExpression(callee)) callee = callee.tag;
    else return false;
  }
  return false;
}

function spanAt(source, line, column) {
  const pos = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  let found;
  const visit = (node) => {
    if (pos < node.getStart(source) || pos > node.getEnd()) return;
    if (!found && ts.isCallExpression(node) && isTestCall(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) return undefined;
  const start = source.getLineAndCharacterOfPosition(found.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(found.getEnd()).line + 1;
  return { start: { line: start, column: 1 }, end: { line: end + 1, column: 1 } };
}

const listed = path.join(mkdtempSync(path.join(tmpdir(), "vitest-list-")), "list.json");
execFileSync("npx", ["vitest", "list", `--json=${listed}`, "--includeTaskLocation", ...tests.keys()], {
  stdio: "inherit",
});
const patterns = new Map(); // ファイル → [{ pattern, location }]
for (const { name, file, location } of JSON.parse(readFileSync(listed, "utf-8"))) {
  if (!location) continue;
  const rel = path.relative(process.cwd(), file).replaceAll(path.sep, "/");
  if (!patterns.has(rel)) patterns.set(rel, []);
  patterns.get(rel).push({ pattern: namePattern(name), location });
}
let located = 0;
const testFiles = {};
for (const [file, defs] of tests) {
  const source = existsSync(file)
    ? ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true)
    : undefined;
  testFiles[file] = {
    tests: defs.map((def) => {
      const hit = source && patterns.get(file)?.find(({ pattern }) => pattern.test(def.name));
      const location = hit && spanAt(source, hit.location.line, hit.location.column);
      if (!location) return def;
      located += 1;
      return { ...def, location };
    }),
  };
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
const base = shards[0];
writeFileSync(
  OUT,
  JSON.stringify({
    schemaVersion: base.schemaVersion,
    thresholds: base.thresholds,
    projectRoot: "frontend",
    framework: { name: base.framework?.name, version: base.framework?.version },
    config: { revision, layers: LAYERS },
    files,
    testFiles,
  }),
);
const counts = {};
for (const entry of Object.values(files)) for (const m of entry.mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
console.log(
  `表 ${OUT} 本 ${shards.length} 書き換え ${JSON.stringify(counts)} テストが走らなかった ${zeroTests}` +
    ` テスト ${testIds.size}（場所の分かった ${located}）`,
);
