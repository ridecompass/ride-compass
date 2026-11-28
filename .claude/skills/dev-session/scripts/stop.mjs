// issue を止める: ステータスを保留にするだけ。保留を見たゲートが、その issue の担当の実行を取り消し、以後は振り出さない
// （tools/flow-gate/src/decide.js の保留の扱い）。保留を解くのはユーザーの決定だけで、チャットでもらった決定を記録した者が
// `--release` で保留から出す（待機にし、ゲートが事実から決め直す）。
// 使い方: node .claude/skills/dev-session/scripts/stop.mjs <issue の番号> [--release]
import { bot, config, graphqlData, isNumber, usage } from "../../../../tools/flow-gate/src/bot.js";

const USAGE = "node .claude/skills/dev-session/scripts/stop.mjs <issue の番号> [--release]";
const [number, flag] = process.argv.slice(2);
if (!isNumber(number) || (flag !== undefined && flag !== "--release")) usage(USAGE);
const release = flag === "--release";
const gh = bot();
const [owner, name] = config.tasks.split("/");
const { repository: { issue } } = graphqlData(gh, "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}",
  { o: owner, r: name, n: Number(number) });
// ゲートがステータスを書くのと同じ形（tools/flow-gate/src/gate.js の issueFieldUpdates）。
graphqlData(gh, "mutation($x:UpdateIssueInput!){updateIssue(input:$x){clientMutationId}}",
  { x: { id: issue.id, issueFieldUpdates: [{ fieldName: config.fields.status.name, operation: "SET", value: release ? "待機" : "保留" }] } });
console.log(release ? `#${number}: 保留から出した（ゲートが事実から決め直す）` : `#${number}: 保留にした（担当の実行はゲートが取り消す）`);
