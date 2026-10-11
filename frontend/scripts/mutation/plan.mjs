// 変異テストで書き換えるファイルを、行数がそろうように分け、指した本のファイルをカンマでつないで出す。frontend の下で打つ。
// 引数: 本の番号（0 から） 本の数
// 書き換えるのは src/ の実装（テスト・テストの足場・構造の検査・型の宣言だけのファイルを除く）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [shard, shards] = process.argv.slice(2).map(Number);
const files = execFileSync("git", ["ls-files", "src/*.ts", "src/*.tsx"], { encoding: "utf-8" })
  .split("\n")
  .filter((f) => f && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
  .filter((f) => !f.startsWith("src/testing/") && !f.startsWith("src/structure/"));
const sized = files
  .map((f) => ({ f, lines: readFileSync(f, "utf-8").split("\n").length }))
  .sort((a, b) => b.lines - a.lines || a.f.localeCompare(b.f));
// 大きい順に、いちばん軽い本へ足す。
const bins = Array.from({ length: shards }, () => ({ lines: 0, files: [] }));
for (const { f, lines } of sized) {
  const bin = bins.reduce((min, b) => (b.lines < min.lines ? b : min));
  bin.lines += lines;
  bin.files.push(f);
}
process.stdout.write(bins[shard].files.sort().join(","));
