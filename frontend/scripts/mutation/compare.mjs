// 同じファイルを2つの口で回した Stryker の結果を、書き換えごとに突き合わせ、表を出す。
// 引数: vitest の口の mutation.json command の口の mutation.json
// vitest の口は、書き換えを通るテストだけを名前で選んで回す（install.sh の直しが効いているかは、ここで分かる）。command の口は、
// 書き換えごとにテスト全体を回すので、選び方に依らない。判定が全部合えば、vitest の口の選び方で見落としが出ていない。
// 判定は「見つけた（Killed・Timeout）」「生き残り（Survived・NoCoverage）」「ほか（RuntimeError 等）」の3つで比べる。
import { readFileSync } from "node:fs";

const [vitestPath, commandPath] = process.argv.slice(2);

function verdict(status) {
  if (status === "Killed" || status === "Timeout") return "見つけた";
  if (status === "Survived" || status === "NoCoverage") return "生き残り";
  return "ほか";
}

function mutants(file) {
  const report = JSON.parse(readFileSync(file, "utf-8"));
  const out = new Map();
  for (const [path, entry] of Object.entries(report.files)) {
    for (const m of entry.mutants) {
      if (m.status === "Ignored") continue;
      const { line, column } = m.location.start;
      out.set(`${path}:${line}:${column} ${m.mutatorName} → ${m.replacement}`, m);
    }
  }
  return out;
}

const byVitest = mutants(vitestPath);
const byCommand = mutants(commandPath);
const keys = [...new Set([...byVitest.keys(), ...byCommand.keys()])].sort();
const table = new Map();
const mismatches = [];
for (const key of keys) {
  const v = byVitest.get(key);
  const c = byCommand.get(key);
  const row = `${v ? verdict(v.status) : "無い"} | ${c ? verdict(c.status) : "無い"}`;
  table.set(row, (table.get(row) ?? 0) + 1);
  if (!v || !c || verdict(v.status) !== verdict(c.status)) {
    mismatches.push(`| \`${key.replaceAll("|", "\\|")}\` | ${v?.status ?? "無い"} | ${c?.status ?? "無い"} |`);
  }
}
const lines = [
  `## vitest の口と command の口の判定（書き換え ${keys.length} 件、外したものを除く）`,
  "",
  "| vitest の口 | command の口 | 件数 |",
  "|---|---|---:|",
  ...[...table].sort().map(([row, n]) => `| ${row} | ${n} |`),
  "",
  mismatches.length ? "### 合わなかった書き換え" : "判定は全部合った。",
];
if (mismatches.length) lines.push("", "| 書き換え | vitest の口 | command の口 |", "|---|---|---|", ...mismatches);
console.log(lines.join("\n"));
