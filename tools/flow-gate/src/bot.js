// 流れのスキルに同梱したスクリプト（.claude/skills/*/scripts/）が、置き場へ Claude の名義（flow.config.json: claude）で gh を打つ包みと、
// スクリプトが共通に使う部品。Worker は読み込まない。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import base from "../flow.config.json" with { type: "json" };
import { settings } from "./settings.js";

// 問いの種類ごとの形は置き場の .md を全部読む（Worker は src/config.js が並べて読む）。
const FORMS = new URL("../question_forms/", import.meta.url);
export const config = settings(base, readdirSync(FORMS).filter((f) => f.endsWith(".md")).map((f) => readFileSync(new URL(f, FORMS), "utf8")));
// gh を bot の名義で打つ関数。名義のトークンが無ければ、何も打たずに 1 で終わる（置き場へユーザーの名義で書かない）。一覧の応答は
// execFileSync の既定の上限（1MB）を超えうるので、上限を広げる。
export function bot() {
  if (!process.env.FLOW_BOT_TOKEN) {
    console.error(`FLOW_BOT_TOKEN が無いので書かない（置き場へは ${config.claude} の名義で書く）`);
    process.exit(1);
  }
  return (args, input) => execFileSync("gh", args, { input, encoding: "utf8", env: { ...process.env, GH_TOKEN: process.env.FLOW_BOT_TOKEN }, stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024 });
}
// スクリプトとして打たれたか（テストが読み込んだときは手順を動かさない）。
export const isMain = (url) => url === pathToFileURL(process.argv[1] ?? "").href;
// issue の番号の引数か。
export const isNumber = (arg) => /^\d+$/.test(arg ?? "");
// 使い方を出して 2 で終わる。
export function usage(text) {
  console.error(`使い方: ${text}`);
  process.exit(2);
}
// 置き場の issue へコメントを書く。REST で書けば1回で済む（gh issue comment は issue の ID を引く1回と書く1回を打つ）。
export const comment = (gh, number, body) => gh(["api", `repos/${config.tasks}/issues/${number}/comments`, "-F", "body=@-", "--silent"], body);
// GraphQL の誤りを1行の文にする。
export const messages = (errors) => errors.map((e) => e.message).join("・");
// GraphQL を1回打ち、応答（data と errors）を返す。無い issue を読むと gh は 1 で終わるが、応答に data があれば読む。
export function graphql(gh, query, variables = {}) {
  try {
    return JSON.parse(gh(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables })));
  } catch (e) {
    let reply = null;
    try {
      reply = JSON.parse(e.stdout);
    } catch {
      // 応答が JSON でない（5xx・通信の途切れ）。
    }
    if (reply?.data) return reply;
    throw e;
  }
}
// GraphQL を1回打ち、誤りが返れば投げ、data を返す。
export function graphqlData(gh, query, variables = {}) {
  const reply = graphql(gh, query, variables);
  if (reply.errors?.length) throw new Error(messages(reply.errors));
  return reply.data;
}
