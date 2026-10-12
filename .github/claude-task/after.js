// 担当のワークフロー（claude-task.yml）の後始末が、担当の実行のファイル（連携が書き出す発言の並び）を読む。担当が落ちても止められても走る。
// 使い方: node .github/claude-task/after.js <作る|確かめる> <実行のファイル> <手番の記録の URL（無ければ空）> <実行の URL>
//   issue に書く終わりのコメントの本文を出す（担当の最後の発言・手番の記録・判定に断られた操作・実行・読み始め）。
//   読み始め（環境変数 READ_FROM。担当の段が始まった時刻）より前のユーザーの文は、担当が読んでいる。ゲートはこの行で、まだ読まれていない文を見分ける
//   （tools/flow-gate/src/facts.js: readFacts）。
// 使い方: node .github/claude-task/after.js --quota <実行のファイル>
//   担当が Claude の利用の上限・認証で止まったときだけ 1 で終わる（見回りがこの段の失敗を読んで振り出しを止める。tools/flow-gate/src/patrol.js）。
//   流れの道具を読み込まずに判じる（担当が作業ツリーの流れの道具を壊していても、上限でないのに落ちて振り出しを止めない）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [kind, file, log, url] = process.argv.slice(2);
const messages = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const QUOTA = ["rate_limit", "billing_error", "authentication_failed", "oauth_org_not_allowed", "account_on_hold"];
if (kind === "--quota") process.exit(messages.some((m) => m?.type === "assistant" && QUOTA.includes(m.error)) ? 1 : 0);

// 終わりのコメントの形（見出し・読み始め）は、実行が始まった版（GITHUB_SHA）の流れの道具から読む。担当が作業ツリーで変えた形でなく、
// そのときデプロイされているゲートと同じ形で書くため。版が無ければ（手で打つとき）作業ツリーのものを読む。
async function flowFacts() {
  const sha = process.env.GITHUB_SHA;
  if (!sha) return import(new URL("../../tools/flow-gate/src/facts.js", import.meta.url).href);
  const dir = mkdtempSync(join(tmpdir(), "flow-gate-"));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  // package.json も取り出す（"type": "module" が無いと src の .js を ES モジュールとして読めない）。
  for (const path of [...git("ls-tree", "-r", "--name-only", sha, "tools/flow-gate/src").split("\n").filter(Boolean), "tools/flow-gate/package.json"]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), git("show", `${sha}:${path}`));
  }
  return import(pathToFileURL(join(dir, "tools/flow-gate/src/facts.js")).href);
}
const { endHead, readFromLine } = await flowFacts();

// 公開の Actions の記録には担当の発言を出さない（コメントは非公開の置き場へ書く）。GitHub のコメントの長さの上限（65536字）に収める。
const result = messages.findLast((m) => m?.type === "result");
const said = messages.filter((m) => m?.type === "assistant").map((m) => (m.message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim()).findLast(Boolean);
const words = (typeof result?.result === "string" && result.result.trim()) || said || "（無い）";
const denied = (result?.permission_denials ?? []).map((d) => `${d.tool_name}: ${String(d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_input?.url ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
const head = `${endHead(kind)}\n\n要約（担当の最後の発言）:\n\n`;
const tail = ["", "", `手番の記録: ${log || "置けなかった（実行のファイルが無いか、置くのに失敗した）"}`,
  ...(denied.length ? ["", "判定に断られた操作:", ...denied.map((d) => `- ${d}`)] : []), "", `実行: ${url}`,
  ...(process.env.READ_FROM ? ["", readFromLine(process.env.READ_FROM)] : [])].join("\n");
console.log(head + words.split("\n").map((l) => `> ${l}`).join("\n").slice(0, 65536 - head.length - tail.length) + tail);
