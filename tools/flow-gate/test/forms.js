// 形のファイル（question_forms/）の骨組み（「## 問い」の行から下）を種類で引く。書く者が埋める問い（判断・操作）は、骨組みの問いの文と
// 答えの行を差し替えて作る。
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../question_forms/", import.meta.url);
export const SKELETON = Object.fromEntries(readdirSync(DIR).map((f) => readFileSync(new URL(f, DIR), "utf8").replace(/\r\n/g, "\n"))
  .map((t) => t.slice(t.search(/^## 問い/m)).trim()).map((s) => [/^## 問い（(.+)）/.exec(s)[1], s]));
export const formed = (kind, text, rows) => {
  const [first, , ...rest] = SKELETON[kind].split("\n");
  return [first, text, "", rest.find((l) => l.startsWith("### ")), ...rows.map((r) => `- ${r}`), "", ...rest.slice(rest.indexOf("<details><summary>判断材料</summary>"))].join("\n");
};
