// 担当のワークフロー（claude-task.yml）の後始末が、担当の実行のファイル（連携が書き出す発言の並び）を読む。担当が落ちても止められても走る。
// 担当が作業ツリーを変えても振り出された版で動くよう、ワークフローは実行の始まりにこのファイルと流れの道具（tools/flow-gate/src）を写して打つ。
// 使い方: FLOW_SRC=<流れの道具の src の置き場> node after.js <実装|検証> <実行のファイル> <手番の記録の URL（無ければ空）> <実行の URL> <読み始めの本文のファイル>
//   issue に書く終わりのコメントの本文を出す（担当の最後の発言・手番の記録・判定に断られた操作・実行・読み始め・読み始めの完了の条件）。
//   形は流れの道具（tools/flow-gate/src/facts.js: endHead・readFromLine・startBlock）が持ち、ゲートが同じ所の読み方で読む。
// 使い方: node after.js --quota <実行のファイル>
//   担当が Claude の利用の上限・認証で止まったときだけ 1 で終わる（見回りがこの段の失敗を読んで振り出しを止める。tools/flow-gate/src/patrol.js）。
//   流れの道具を読み込まずに判じる（流れの道具が読めなくても、上限でないのに落ちて振り出しを止めない）。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8") : "");
// 担当が書きかけで止められると、実行のファイルは JSON として読めない。読めなければ無いものとして扱う（後始末を落とさない）。
const parsed = (text) => {
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
};
const [kind, file, log, url, startFile] = process.argv.slice(2);
const messages = parsed(read(file));
const QUOTA = ["rate_limit", "billing_error", "authentication_failed", "oauth_org_not_allowed", "account_on_hold"];
if (kind === "--quota") process.exit(messages.some((m) => m?.type === "assistant" && QUOTA.includes(m.error)) ? 1 : 0);
const { endHead, readFromLine, startBlock } = await import(pathToFileURL(`${process.env.FLOW_SRC}/facts.js`).href);

// 公開の Actions の記録には担当の発言を出さない（コメントは非公開の置き場へ書く）。GitHub のコメントの長さの上限（65536字）に収める。
const result = messages.findLast((m) => m?.type === "result");
const said = messages.filter((m) => m?.type === "assistant").map((m) => (m.message?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim()).findLast(Boolean);
const words = (typeof result?.result === "string" && result.result.trim()) || said || "（無い）";
const denied = (result?.permission_denials ?? []).map((d) => `${d.tool_name}: ${String(d.tool_input?.command ?? d.tool_input?.file_path ?? d.tool_input?.url ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
const head = `${endHead(kind)}\n\n要約（担当の最後の発言）:\n\n`;
const tail = ["", "", `手番の記録: ${log || "置けなかった（実行のファイルが無いか、置くのに失敗した）"}`,
  ...(denied.length ? ["", "判定に断られた操作:", ...denied.map((d) => `- ${d}`)] : []), "", `実行: ${url}`,
  ...(process.env.READ_FROM ? ["", readFromLine(process.env.READ_FROM)] : []), "", startBlock(read(startFile))].join("\n");
console.log(head + words.split("\n").map((l) => `> ${l}`).join("\n").slice(0, 65536 - head.length - tail.length) + tail);
