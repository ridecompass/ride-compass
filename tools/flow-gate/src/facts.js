// タスクの事実を読む（src/decide.js: decide が受ける形）。置き場の issue とコードのリポジトリの作業ブランチの PR を GraphQL の1回で読み、
// 担当が付いているかは見回りの記録（src/patrol.js: Patrol）から受ける。見回りのボードの一覧も同じ読み方を使う。
import { APPLIED, answerText, checkQuestion, conditions, droppedQuestion, isAnswer, isQuestion, latestQuestion, norm, remaining } from "./questions.js";

// ボードの欄（ステータス・優先度・着手可能日時）の読み方。欄の名前は設定が持つ。
export const fieldsOf = ({ fields: f }) => `status:fieldValueByName(name:"${f.status}"){...on ProjectV2ItemFieldSingleSelectValue{name}}
 priority:fieldValueByName(name:"${f.priority}"){...on ProjectV2ItemFieldSingleSelectValue{name}} start:fieldValueByName(name:"${f.start}"){...on ProjectV2ItemFieldTextValue{text}}`;
// 着手可能日時は「YYYY-MM-DD」か「YYYY-MM-DD HH:MM」（日本時間）だけを受ける。形の合わない値は受け入れず（badStart はその値。ゲートが知らせる）、
// 待つと決めた意図を守ってまだ先と読む。
const START_FORM = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
const jst = (text) => (START_FORM.test(text) ? new Date(`${text.replace(" ", "T")}${text.includes(":") ? "" : "T00:00"}:00+09:00`) : null);
// issue が入っているゲートのボードの世界と項目（設定の順に探す）。
const itemOf = (config, items) => Object.entries(config.boards).map(([world, n]) => ({ world, item: items.find((i) => i.project.number === n) })).find((x) => x.item) ?? {};
// 矢印1本でつながる issue（前提・子・親）の読み方。1件を決め直すときも、振り出しの一覧も同じ（親の本文は、1件を決め直すときだけ要る）。
export const relationsOf = (config, body = false) => `blockedBy(first:20){nodes{number state stateReason}} subIssues(first:50){nodes{number state stateReason}}
 parent{number state stateReason ${body ? "body" : ""} labels(first:20){nodes{name}} projectItems(first:5){nodes{project{number} ${fieldsOf(config)}}}}`;
// 完成でなく閉じた（見送り・重複）相手は、その結果を当てにできないので、続けるかを問う側に数える。
const dropped = (x) => x.state === "CLOSED" && ["NOT_PLANNED", "DUPLICATE"].includes(x.stateReason);
// ボードの項目から、ボードの世界・欄・待ちを組む（1件を決め直すときも、振り出しの一覧も同じ）。子（親を持つ issue）は、優先度・着手可能日時・
// 急ぎ・保留を自分では持たず、親の値を見る（親が閉じていれば、閉じるのを待つ子なので振り出さない）。待つ相手は前提と子で、どちらも同じに扱う。
export function taskOf(config, issue, items, now = new Date()) {
  const { world, item } = itemOf(config, items);
  const parent = issue.parent;
  const from = parent ? itemOf(config, parent.projectItems.nodes).item : item;
  const text = from?.start?.text?.trim();
  const start = jst(text);
  const own = item?.start?.text?.trim();
  const waits = [...issue.blockedBy.nodes, ...(issue.subIssues?.nodes ?? [])];
  return { board: world, item: item?.id, status: item?.status?.name, priority: from?.priority?.name, type: issue.issueType?.name ?? null,
    open: issue.state === "OPEN", blocked: waits.some((w) => w.state === "OPEN"), dropped: waits.filter(dropped).map((w) => w.number),
    future: Boolean(text) && (!start || start > now), badStart: own && !jst(own) ? own : null,
    urgent: Boolean((parent ?? issue).labels?.nodes.some((l) => l.name === config.urgentLabel)), held: Boolean(parent) && (parent.state === "CLOSED" || from?.status?.name === "保留") };
}
export const jstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 日本時間の「YYYY-MM-DD HH:MM」
// 担当の実行の名前「#<番号> <種類> <振り出しの識別子>」（claude-task.yml の run-name。手で起こした実行は識別子が無い）。
export function runOf(title) {
  const [, number, kind, key] = /^#(\d+) (\S+)(?: (\S+))?/.exec(title ?? "") ?? [];
  return number ? { number: Number(number), kind, key } : null;
}

const query = (config) => `query($to:String!,$tn:String!,$n:Int!,$co:String!,$cn:String!,$head:String!){
 t:repository(owner:$to,name:$tn){issue(number:$n){id state stateReason createdAt closedAt lastEditedAt editor{login} body author{login} issueType{name} assignees(first:10){nodes{login}}
  comments(last:40){nodes{body createdAt author{login}}}projectItems(first:5){nodes{id project{number} ${fieldsOf(config)}}} ${relationsOf(config, true)}
  timelineItems(first:50,itemTypes:[ISSUE_TYPE_CHANGED_EVENT]){nodes{...on IssueTypeChangedEvent{prevIssueType{name} issueType{name}}}}}}
 c:repository(owner:$co,name:$cn){pullRequests(headRefName:$head,first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
  id state isDraft merged mergedAt mergeCommit{statusCheckRollup{state} checkSuites(last:20){nodes{updatedAt}}}
  commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state} checkSuites(last:20){nodes{updatedAt}}}}}
  timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}}}}}`;
const ROLLUP = { SUCCESS: "SUCCESS", FAILURE: "FAILURE", ERROR: "FAILURE", PENDING: "PENDING", EXPECTED: "PENDING" };

// 変異テストの生き残りの数と、その結果が出た時刻。
async function survivors(gh, config, sha) {
  const { check_runs: [run] } = await gh.rest("GET", `/repos/${config.code}/commits/${sha}/check-runs?check_name=${config.mutationCheck}`);
  const notes = run ? await gh.rest("GET", `/repos/${config.code}/check-runs/${run.id}/annotations?per_page=100`) : [];
  return { count: notes.filter((a) => a.title === "テストが気づかない書き換え").length, at: Date.parse(run?.completed_at) };
}

// issue の全部のコメントの本文（古い順）。
async function allComments(gh, config, number) {
  const all = [];
  for (let page = 1; ; page++) {
    const got = await gh.rest("GET", `/repos/${config.tasks}/issues/${number}/comments?per_page=100&page=${page}`);
    all.push(...got.map((x) => norm(x.body)));
    if (got.length < 100) return all;
  }
}

// 見回りの状態（src/patrol.js: Patrol.state）: record は担当の記録（終わった実行の印を含む）、stopped は振り出しを止めている理由。
export async function readFacts(gh, config, number, { record, stopped }) {
  const [to, tn] = config.tasks.split("/");
  const [co, cn] = config.code.split("/");
  const { t: { issue: i }, c } = await gh.gql(query(config), { to, tn, n: number, co, cn, head: `${config.branchPrefix}${number}` });
  const mine = record.filter((r) => r.number === number);
  const runs = mine.filter((r) => r.state !== "completed");
  const made = Math.max(0, ...mine.filter((r) => r.state === "completed" && r.kind === "作る").map((r) => r.at));
  const open = c.pullRequests.nodes.find((p) => p.state === "OPEN");
  const head = open?.commits.nodes.at(-1);
  const checks = ROLLUP[head?.commit.statusCheckRollup?.state];
  // 生き残りは、持たれていない PR の CI が通ったときだけ要る。作る担当がその結果のあとに持っていなければ新しい。
  const mutants = !runs.length && open && checks === "SUCCESS" ? await survivors(gh, config, head.commit.oid) : { count: 0 };
  const drafted = open?.timelineItems.nodes[0]?.createdAt;
  const merged = c.pullRequests.nodes.find((p) => p.merged); // 新しいものから並ぶ
  const nodes = i.comments.nodes;
  const comments = nodes.map((n) => norm(n.body)); // 最近のコメント（同じ知らせを重ねないためにも読む）
  const last = comments.at(-1);
  // ユーザーが書いた文（答えなら決まった形の行のほかの文）を、Claude が読んだか。担当は、終わりのコメントの「読み始め:」の時刻より前のコメントを
  // 読んでいる（前の形の終わりのコメントは書いた時刻）。対話作業の issue は開発機の対話のセッションが読んでから書くので、Claude のコメントがあれば
  // それより前を読んでいる。閉じたあとの文だけを数える（閉じるときに一緒に書いた文は、閉じる決定の一部）。
  const at = (n) => Date.parse(n.createdAt);
  const by = (n, login) => n.author?.login === login;
  const dialog = (itemOf(config, i.projectItems.nodes).world ?? (i.issueType?.name === config.dialogType ? "dialog" : "actions")) === "dialog";
  const reads = nodes.filter((n) => by(n, config.claude) && (dialog || /^### \S+担当の終わり/.test(norm(n.body))))
    .map((n) => Date.parse(/^読み始め: (\S+)$/m.exec(norm(n.body))?.[1] ?? n.createdAt));
  const lastRead = Math.max(0, ...reads);
  const closedAt = Date.parse(i.closedAt) || 0;
  const said = (n) => (isAnswer(n.body) ? answerText(n.body) : norm(n.body).trim());
  const unread = nodes.some((n) => by(n, config.user) && said(n) && at(n) > lastRead && (i.state === "OPEN" || at(n) > closedAt));
  // 今の問いへの答えを、Claude が読んだか・ゲートが当てたか（書いた文のある答えは、読んだあとに一度だけ当てる）。
  const asked = nodes.findLastIndex((n) => isQuestion(n.body));
  const answer = asked < 0 ? null : nodes.slice(asked + 1).find((n) => isAnswer(n.body));
  const answerRead = Boolean(answer) && reads.some((t) => t > at(answer));
  const answerApplied = Boolean(answer) && nodes.some((n) => at(n) > at(answer) && norm(n.body).startsWith(APPLIED));
  // 子は、親が閉じて開き直されないなら（要望が満たされた・やめた）生きていない。条件が残ったまま完成で閉じた親は、ゲートが開き直す。
  const p = i.parent;
  const dead = Boolean(p) && p.state === "CLOSED" && !(p.stateReason === "COMPLETED" && remaining(p.body).length);
  // 見送りの相手で続けるかを問うたか。最近のコメントに無ければ、さかのぼって全部のコメントを探す（答えたあとに問い直さない）。
  const task = taskOf(config, i, i.projectItems.nodes);
  const asking = task.dropped.length ? droppedQuestion(task.dropped) : null;
  const droppedAsked = Boolean(asking) && (comments.some((x) => x.includes(asking)) || (await allComments(gh, config, number)).some((x) => x.includes(asking)));
  // 最後の動き: ゲートのほかが書いたコメント・本文の編集・作業ブランチの PR のコミットとマージ・検査の終わり・担当の実行の始まりと終わり・
  // issue を作ったときのうち、一番新しい時刻。GitHub と見回りの記録から出し、起点をだれも持たない。
  const gate = config.gateBot.replace(/\[bot\]$/, "");
  const suites = (commit) => commit?.checkSuites?.nodes.map((x) => x.updatedAt) ?? [];
  const lastMove = Math.max(0, ...[i.createdAt, i.editor?.login !== gate && i.lastEditedAt, ...nodes.filter((n) => n.author?.login !== gate).map((n) => n.createdAt),
    ...c.pullRequests.nodes.flatMap((p) => [p.mergedAt, p.commits.nodes.at(-1)?.commit.committedDate, ...suites(p.commits.nodes.at(-1)?.commit), ...suites(p.mergeCommit)])]
    .map((t) => Date.parse(t)).filter(Number.isFinite), ...mine.map((r) => r.at));
  // 外の事情で振り出せない: 担当の枠が埋まっている（種類ごと）か、見回りが振り出しを止めている。
  const full = Object.fromEntries(Object.entries(config.slots).map(([kind, n]) => [kind, record.filter((h) => h.state !== "completed" && h.kind === kind).length >= n]));
  return { ...task, droppedAsked, lastMove, full, stopped: Boolean(stopped), now: config.now?.() ?? Date.now(), unread, answerRead, answerApplied, number, id: i.id, closedAs: i.stateReason, author: i.author?.login, body: i.body,
    conditions: conditions(i.body), remaining: remaining(i.body), assignees: i.assignees.nodes.map((a) => a.login), question: latestQuestion(comments, config.questionTemplate),
    runs, parent: p && { number: p.number }, dead, children: i.subIssues.nodes, origin: Number(/^分割元: #(\d+)\s*$/m.exec(norm(i.body))?.[1]) || null,
    types: i.timelineItems.nodes.map((e) => e.prevIssueType?.name ?? null), // 今より前の種類（古い順）
    merged: Boolean(merged), mergeChecks: ROLLUP[merged?.mergeCommit?.statusCheckRollup?.state],
    badQuestion: last && isQuestion(last) ? checkQuestion(config.questionTemplate, last) : [], comments,
    pr: open && { id: open.id, draft: open.isDraft, checks, newSurvivors: mutants.count > 0 && !(made > mutants.at), backToDraft: Boolean(drafted && drafted > head.commit.committedDate) } };
}
