// issue を起こす。本文の形（.claude/skills/file-issue/SKILL.md「issue の形」）と子の決まり（同「分ける」）を照らし、合えば GraphQL で
// 読む1回・作る1回（題名・本文・種類・親・欄）・前後の関係を張る1回（あれば）で作る。合わなければ作らずに理由を出して 1 で終わる。
// 使い方: node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>]
//   [--parent <親>] [--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <規模>] [--priority <優先度>] [--start <着手可能日時>] [--hold]
//   欄だけ入れ直す: node .claude/skills/file-issue/scripts/new-issue.mjs --fill <番号> [--size ...] [--priority ...] [--start ...]
//   規模と優先度の選択肢は設定（flow.config.json: fields）が持つ。
//   --hold は、開発機の対話のセッションが起こしてそのまま持つ issue に、作るときからラベル「開発機で作業中」（flow.config.json: devLabel）を付ける。
//   --parent は子（種類は親と同じ。子と孫の決まりは tools/flow-gate/src/family.js）。--origin は要望ごとの切り出し（本文に分割元の行を置く）。
import { readFileSync } from "node:fs";
import { bot, config, graphql, graphqlData, isNumber, messages, usage } from "../../../../tools/flow-gate/src/bot.js";
import { CHILD_FIELDS, NO_GRANDCHILD, makesGrandchild, originLine, originOf } from "../../../../tools/flow-gate/src/family.js";
import { SET_FIELDS, fieldProblems, fieldValues } from "../../../../tools/flow-gate/src/fields.js";
import { conditions, misboundSteps, norm } from "../../../../tools/flow-gate/src/questions.js";

// 畳んだ節の名前と順（2 は種類ごとに1つ）。
const SECTIONS = [["不具合: 起きていること", "要望: 困りごと", "保守: 背景", "調査: 明らかにしたいこと"], ["やること", "調べ方"], ["決めること"],
  ["完了の条件"], ["経緯"], ["規模と優先度の根拠"]];
// 節の頭は <details> と <summary> が同じ行でも別の行でもよい。
const sectionNames = (text) => [...text.matchAll(/^<details>\s*<summary>(.+?)<\/summary>/gm)].map((m) => m[1]);

// 2 の節が種類に合わない所（空なら合う）。子は親を読むまで種類が決まらないので、作る前にもう一度これだけを当てる。
function typeProblems(body, type) {
  const head = sectionNames(norm(body)).find((n) => SECTIONS[0].includes(n));
  return head && type && SECTIONS[0].some((n) => n.startsWith(`${type}:`)) && !head.startsWith(`${type}:`) ? [`種類「${type}」に合わない節「${head}」`] : [];
}

// 本文と欄が決まりに合わない所（空なら合う）。child は子として作るとき。
function issueProblems(body, { type, child = false, size, priority, start }) {
  const text = norm(body).trim();
  const problems = [];
  if (!text || text.startsWith("<details>")) problems.push("本文の頭に、畳まない要約が無い");
  if (/^#{1,6} /m.test(text)) problems.push("見出し（#）は使わない（節は <details><summary> で畳む）");
  let at = -1;
  for (const name of sectionNames(text)) {
    const k = SECTIONS.findIndex((s) => s.includes(name));
    if (k < 0) problems.push(`知らない節「${name}」（節は ${SECTIONS.map((s) => s.join("／")).join("・")} の順）`);
    else if (k <= at) problems.push(`節「${name}」の順か重なりが違う`);
    else at = k;
  }
  problems.push(...typeProblems(text, type));
  // 子も自分の約束（完了の条件）を持つ。子は優先度・着手可能日時を持たず、親の値を読む。
  if (!conditions(text).length) problems.push("完了の条件が無い");
  problems.push(...misboundSteps(text).map((n) => `やることの ${n} の行き先が、完了の条件の文の頭・#<番号>・見送り（<理由>）のどれにも当たらない`));
  if (child && (priority || start)) problems.push(CHILD_FIELDS);
  if (!child && type !== config.dialogType && (!size || !priority)) problems.push("規模と優先度を入れる（--size・--priority）");
  return [...problems, ...fieldProblems(config, fieldsOf({ size, priority, start }))];
}

// 要望ごとの切り出しの本文に分割元の行を、要約の段落のあとへ置く（もうあれば置かない）。
function withOrigin(body, origin) {
  const text = norm(body).trim();
  if (originOf(text) === Number(origin)) return text;
  const cut = text.indexOf("\n\n");
  return cut < 0 ? `${text}\n\n${originLine(origin)}` : `${text.slice(0, cut)}\n\n${originLine(origin)}${text.slice(cut)}`;
}

// 引数を読む。知らない口・値の無い口があれば null（打ち間違いで前提や親の無い issue を作らない）。FLAGS は値を取らない口。
const KEYS = ["title", "body-file", "type", "parent", "origin", "blocked-by", "blocking", "size", "priority", "start", "fill"];
const FLAGS = ["hold"];
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i].startsWith("--") && FLAGS.includes(key)) {
      opts[key] = true;
      i -= 1;
      continue;
    }
    if (!argv[i].startsWith("--") || !KEYS.includes(key) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return null;
    opts[key] = argv[i + 1];
  }
  return opts;
}

const fieldsOf = ({ size, priority, start }) => [["size", size], ["priority", priority], ["start", start]].filter(([, v]) => v);
const fieldLines = (values) => values.map(([key, value]) => `${config.fields[key].name}: ${value}`);
const numbers = (list) => (list ? list.split(",").map((n) => n.trim().replace(/^#/, "")) : []);
const reason = (e) => String(e.stderr || e.message).trim();

// 作る前に読む1回: 置き場の ID・種類・開発機が持つラベル・親・前後の issue。番号は数字だけを通してから埋める。
function readQuery(parent, refs) {
  const issue = (alias, n, fields) => ` ${alias}:issue(number:${n}){${fields}}`;
  return "query($owner:String!,$name:String!,$hold:String!){repository(owner:$owner,name:$name){id issueTypes(first:50){nodes{id name}} hold:label(name:$hold){id}" +
    (parent ? issue("parent", parent, "id state issueType{name} parent{number}") : "") + refs.map((n) => issue(`i${n}`, n, "id")).join("") + "}}";
}

// 読んだ置き場から、作る入力と前後の関係の ID を決める。作れない理由があれば { stop } だけを返す（そのときは作らない）。
function plan(repo, opts, body, { blockedBy, blocking, values }) {
  const stop = [];
  const p = repo.parent;
  if (opts.parent && !p) stop.push(`親 #${opts.parent} が無い`);
  else if (p) {
    stop.push(...[makesGrandchild(p.parent, false) && `親 #${opts.parent} は #${p.parent.number} の子です。${NO_GRANDCHILD}`,
      p.state !== "OPEN" && `親 #${opts.parent} は閉じている`,
      !p.issueType && `親 #${opts.parent} に種類が無い（子の種類は親と同じにする）`,
      opts.type && p.issueType && opts.type !== p.issueType.name && `子の種類は親と同じ（${p.issueType.name}）`].filter(Boolean),
    ...typeProblems(body, p.issueType?.name));
  }
  const type = p ? p.issueType?.name : opts.type;
  const typeId = repo.issueTypes.nodes.find((t) => t.name === type)?.id;
  if (type && !typeId) stop.push(`種類「${type}」は置き場に無い（${repo.issueTypes.nodes.map((t) => t.name).join("・")}）`);
  const idOf = (n) => repo[`i${n}`]?.id;
  const missing = [...blockedBy, ...blocking].filter((n) => !idOf(n));
  if (missing.length) stop.push(`${missing.map((n) => `#${n}`).join("・")} が無い`);
  if (opts.hold && !repo.hold) stop.push(`ラベル「${config.devLabel}」が置き場に無い`);
  if (stop.length) return { stop };
  // 開発機で起こしてそのまま持つ issue は、作る要求の中でラベルを付ける（あとから付けると、その間にゲートが担当へ振り出す）。
  const input = {
    repositoryId: repo.id, title: opts.title, body, issueTypeId: typeId,
    ...(p && { parentIssueId: p.id }), ...(values.length && { issueFields: fieldValues(config, values) }),
    ...(opts.hold && { labelIds: [repo.hold.id] }),
  };
  return { input, blockedBy: blockedBy.map(idOf), blocking: blocking.map(idOf) };
}

const CREATE = "mutation($in:CreateIssueInput!){createIssue(input:$in){issue{id number url}}}";
// 作られたかは、作る直前より後に動いた issue のうち新しく作られた順に、題名で探す（トークンの名義には頼らない）。
const MADE = "query($owner:String!,$name:String!,$since:DateTime!){repository(owner:$owner,name:$name){" +
  "issues(first:20,filterBy:{since:$since},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number url title}}}}";

// 前後の関係（blocked by）を1回で張る。issue の組は [後, 先]。
function relate(gh, pairs) {
  const vars = Object.fromEntries(pairs.flatMap(([i, b], k) => [[`i${k}`, i], [`b${k}`, b]]));
  graphqlData(gh, `mutation(${pairs.map((_, k) => `$i${k}:ID!,$b${k}:ID!`).join(",")}){` +
    pairs.map((_, k) => `r${k}:addBlockedBy(input:{issueId:$i${k},blockingIssueId:$b${k}}){clientMutationId}`).join(" ") + "}", vars);
}

// 照らして作る。出す行（out）と、1 で終える理由（err）を返す。now は作る直前の時刻（作られたかを確かめるときの起点）。
function file(gh, opts, body) {
  const now = new Date();
  const { owner, name } = config.repos.tasks;
  const refs = { blockedBy: numbers(opts["blocked-by"]), blocking: numbers(opts.blocking), values: fieldsOf(opts) };
  const all = [...refs.blockedBy, ...refs.blocking];
  // 子の種類は親から決まるので、親を読むまでは種類に依らない照らしだけを当てる。
  const early = [all.some((n) => !isNumber(n)) && "前後の issue は番号で書く（--blocked-by 5,6）",
    opts.parent && !isNumber(opts.parent) && "親は番号で書く（--parent 5）",
    opts.origin && !isNumber(opts.origin) && "分割元は番号で書く（--origin 5）",
    !opts.parent && !opts.type && "種類が無い（--type）",
    ...issueProblems(body, { type: opts.parent ? undefined : opts.type, child: Boolean(opts.parent), size: opts.size, priority: opts.priority, start: opts.start })].filter(Boolean);
  if (early.length) return { out: [], err: `作らない: ${early.join("・")}` };
  let repo;
  try {
    const read = graphql(gh, readQuery(opts.parent, all), { owner, name, hold: config.devLabel });
    // 無い issue（NOT_FOUND）は plan が名指して断る。それ以外の誤りは読めなかったものとして扱う。
    const failed = (read.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
    repo = read.data?.repository;
    if (failed.length || !repo) throw new Error(messages(failed) || "置き場が無い");
  } catch (e) {
    return { out: [], err: `作らない: 置き場を読めなかった（${reason(e)}）` };
  }
  const planned = plan(repo, opts, body, refs);
  if (planned.stop) return { out: [], err: `作らない: ${planned.stop.join("・")}` };
  let made;
  try {
    const reply = graphql(gh, CREATE, { in: planned.input });
    // errors が付いていても issue が返っていれば作られている（作り直させない）。
    made = reply.data?.createIssue?.issue;
    if (!made) return { out: [], err: `作らなかった: ${messages(reply.errors ?? [])}` };
    if (reply.errors?.length) return { out: [made.url], err: `#${made.number} は作った（作り直さない）が、誤りが返った（${messages(reply.errors)}）。種類・親・欄を issue の画面で確かめる` };
  } catch (e) {
    return { out: [], err: unsure(gh, opts, { owner, name, now, why: reason(e) }) };
  }
  const out = [made.url, ...fieldLines(refs.values)];
  const pairs = [...planned.blockedBy.map((b) => [made.id, b]), ...planned.blocking.map((k) => [k, made.id])];
  if (!pairs.length) return { out, err: null };
  try {
    relate(gh, pairs);
    return { out, err: null };
  } catch (e) {
    return { out, err: `#${made.number} は作った（作り直さない）。前後の関係を張れなかった（${reason(e)}）。次で張る:\n  ${relateCommand(made.number, opts)}` };
  }
}

// 前後の関係を手で張り直すコマンド（関係が無ければ空）。
const relateCommand = (number, opts) => (opts["blocked-by"] || opts.blocking ? `GH_TOKEN=$FLOW_BOT_TOKEN gh issue edit ${number} -R ${config.tasks}` +
  (opts["blocked-by"] ? ` --add-blocked-by ${opts["blocked-by"]}` : "") + (opts.blocking ? ` --add-blocking ${opts.blocking}` : "") : "");

// 作る要求が応答を返さずに落ちても、GitHub の側では作られていることがある。打ち直すと二重に作るので、作られたかを1回だけ読んで終える。
function unsure(gh, opts, { owner, name, now, why }) {
  const since = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  let found;
  try {
    found = graphqlData(gh, MADE, { owner, name, since }).repository.issues.nodes.find((i) => i.title.trim() === opts.title.trim());
  } catch (e) {
    return `作る要求が落ち（${why}）、作られたかも確かめられなかった（${reason(e)}）。打ち直す前に、` +
      `https://github.com/${config.tasks}/issues で題名「${opts.title}」の issue が無いことを確かめる`;
  }
  if (!found) return `作る要求が落ち（${why}）、作られていない。GitHub が戻ってから打ち直す`;
  const left = relateCommand(found.number, opts);
  return `作る要求は落ちた（${why}）が、#${found.number} は作られていた（作り直さない）: ${found.url}${left && `。前後の関係は次で張る:\n  ${left}`}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const choices = (key) => Object.keys(config.fields[key].options).join("|");
  if (opts?.fill) {
    if (!isNumber(opts.fill)) usage(`node .claude/skills/file-issue/scripts/new-issue.mjs --fill <番号> [--size <${choices("size")}>] [--priority <${choices("priority")}>] [--start <着手可能日時>]`);
    return fill(bot(), opts.fill, opts);
  }
  if (!opts?.title || !opts["body-file"]) usage("node .claude/skills/file-issue/scripts/new-issue.mjs --title <題名> --body-file <本文のファイル> [--type <種類>] [--parent <親>] " +
    `[--origin <分割元>] [--blocked-by <前,...>] [--blocking <後,...>] [--size <${choices("size")}>] [--priority <${choices("priority")}>] [--start <着手可能日時>] [--hold]`);
  let body = readFileSync(opts["body-file"], "utf8");
  if (opts.origin) body = withOrigin(body, opts.origin);
  const { out, err } = file(bot(), opts, body);
  for (const line of out) console.log(line);
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

// 欄を入れて、入れた欄を出す。落ちても issue はできているので、作り直させずに、作った番号と入れ直すコマンドを出して 1 で終わる。
function fill(gh, number, opts) {
  const values = fieldsOf(opts);
  const left = fillFields(gh, number, values);
  if (left) {
    console.error(left);
    process.exit(1);
  }
  for (const line of fieldLines(values)) console.log(line);
}

// 作った issue の欄（issue fields）を1回で入れる。全部入れば null、落ちたら作った番号と入れ直すコマンドの文。
function fillFields(gh, number, values) {
  if (!values.length) return null;
  try {
    const id = JSON.parse(gh(["issue", "view", String(number), "-R", config.tasks, "--json", "id"])).id;
    graphqlData(gh, SET_FIELDS, { i: id, v: fieldValues(config, values) });
    return null;
  } catch (e) {
    return `#${number} は作った（作り直さない）。欄を入れられなかった（${reason(e)}）。欄は次で入れる:\n` +
      `  node .claude/skills/file-issue/scripts/new-issue.mjs --fill ${number} ${values.map(([k, v]) => `--${k} ${v}`).join(" ")}`;
  }
}

await main();
