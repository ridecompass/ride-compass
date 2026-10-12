// タスクの事実を読む（src/decide.js: decide が受ける形）。置き場の issue とコードのリポジトリの作業ブランチの PR を GraphQL の1回で、担当の実行は
// Actions の実行の一覧から読む。ゲートは事実の写しを持たない（持ち主は GitHub）。見回りの一覧も同じ読み方を使う。
import { FIELDS, START_FORM, valuesOf } from "./fields.js";
import { APPLIED, answerText, checkQuestion, conditions, droppedQuestion, isAnswer, isQuestion, latestQuestion, norm, remaining } from "./questions.js";

// 着手可能日時の形の合わない値は受け入れず（badStart はその値。ゲートが知らせる）、待つと決めた意図を守ってまだ先と読む。
const jst = (text) => (START_FORM.test(text) ? new Date(`${text.replace(" ", "T")}${text.includes(":") ? "" : "T00:00"}:00+09:00`) : null);
// 対話作業か。種類は作るとき（最初に付いた種類）で決まり、あとから境目をまたいで変えても変わらない（types は今より前の種類の古い順）。
const dialogOf = (config, types, type) => [...types, type].find(Boolean) === config.dialogType;
// 矢印1本でつながる issue（前提・子・親）の読み方。1件を決め直すときも、振り出しの一覧も同じ（親の本文は、1件を決め直すときだけ要る）。
export const relationsOf = (body = false) => `blockedBy(first:20){nodes{number state stateReason}} subIssues(first:50){nodes{number state stateReason}}
 parent{number state stateReason ${body ? "body" : ""} labels(first:20){nodes{name}} ${FIELDS}}`;
// 完成でなく閉じた（見送り・重複）相手は、その結果を当てにできないので、続けるかを問う側に数える。
const dropped = (x) => x.state === "CLOSED" && ["NOT_PLANNED", "DUPLICATE"].includes(x.stateReason);
// issue の欄から、欄と待ちを組む（1件を決め直すときも、振り出しの一覧も同じ）。子（親を持つ issue）は、優先度・着手可能日時・
// 急ぎ・保留を自分では持たず、親の値を見る（親が閉じていれば、閉じるのを待つ子なので振り出さない）。待つ相手は前提と子で、どちらも同じに扱う。
export function taskOf(config, issue, now = new Date()) {
  const f = config.fields;
  const own = valuesOf(issue);
  const parent = issue.parent;
  const from = parent ? valuesOf(parent) : own;
  const text = from[f.start.name]?.trim();
  const start = jst(text);
  const mine = own[f.start.name]?.trim();
  const waits = [...issue.blockedBy.nodes, ...(issue.subIssues?.nodes ?? [])];
  return { status: own[f.status.name], priority: from[f.priority.name], type: issue.issueType?.name ?? null,
    open: issue.state === "OPEN", blocked: waits.some((w) => w.state === "OPEN"), dropped: waits.filter(dropped).map((w) => w.number),
    future: Boolean(text) && (!start || start > now), badStart: mine && !jst(mine) ? mine : null,
    urgent: Boolean((parent ?? issue).labels?.nodes.some((l) => l.name === config.urgentLabel)), held: Boolean(parent) && (parent.state === "CLOSED" || from[f.status.name] === "保留") };
}
export const jstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 日本時間の「YYYY-MM-DD HH:MM」
// 担当の実行の名前「#<番号> <種類> <振り出しの識別子>」（claude-task.yml の run-name。手で起こした実行は識別子が無い）。
export function runOf(title) {
  const [, number, kind, key] = /^#(\d+) (\S+)(?: (\S+))?/.exec(title ?? "") ?? [];
  return number ? { number: Number(number), kind, key } : null;
}
// 担当のワークフロー（config.workflow）の近ごろの実行（新しい順に100本）。動いているか・枠が埋まっているか・最後の動きは、決め直すたびにここから読む。
export async function recentRuns(gh, config) {
  const { workflow_runs: runs } = await gh.rest("GET", `/repos/${config.code}/actions/workflows/${config.workflow}/runs?per_page=100&exclude_pull_requests=true`);
  return runs.map((r) => ({ ...runOf(r.display_title), id: r.id, active: r.status !== "completed", conclusion: r.conclusion,
    created: Date.parse(r.created_at), updated: Date.parse(r.updated_at) })).filter((r) => r.number);
}

const query = (config) => `query($to:String!,$tn:String!,$n:Int!,$co:String!,$cn:String!,$head:String!){
 t:repository(owner:$to,name:$tn){issue(number:$n){id state stateReason closedAt body author{login} issueType{name} assignees(first:10){nodes{login}}
  comments(last:40){nodes{body createdAt author{login}}} ${FIELDS} ${relationsOf(true)}
  timelineItems(first:50,itemTypes:[ISSUE_TYPE_CHANGED_EVENT]){nodes{...on IssueTypeChangedEvent{prevIssueType{name} issueType{name}}}}}}
 c:repository(owner:$co,name:$cn){pullRequests(headRefName:$head,first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
  id state isDraft merged mergeCommit{statusCheckRollup{state}} commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state}}}}
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

// 担当の終わりのコメントの見出し（.github/claude-task/after.js が書く）。
export const END = /^### (\S+)担当の終わり/;

// runs は出来事1件につき1回読んだ担当の実行の一覧（recentRuns）。
export async function readFacts(gh, config, number, runs) {
  const [to, tn] = config.tasks.split("/");
  const [co, cn] = config.code.split("/");
  const { t: { issue: i }, c } = await gh.gql(query(config), { to, tn, n: number, co, cn, head: `${config.branchPrefix}${number}` });
  const held = runs.filter((r) => r.number === number && r.active).sort((a, b) => a.created - b.created); // 古い順（2本目からは二重の実行）
  const open = c.pullRequests.nodes.find((p) => p.state === "OPEN");
  const head = open?.commits.nodes.at(-1);
  const checks = ROLLUP[head?.commit.statusCheckRollup?.state];
  // 生き残りは、持たれていない PR の CI が通ったときだけ要る。作る担当がその結果のあとに持っていなければ新しい。
  const mutants = !held.length && open && checks === "SUCCESS" ? await survivors(gh, config, head.commit.oid) : { count: 0 };
  const drafted = open?.timelineItems.nodes[0]?.createdAt;
  const merged = c.pullRequests.nodes.find((p) => p.merged); // 新しいものから並ぶ
  const nodes = i.comments.nodes;
  const comments = nodes.map((n) => norm(n.body)); // 最近のコメント（同じ知らせを重ねないためにも読む）
  const last = comments.at(-1);
  // ユーザーが書いた文（答えなら決まった形の行のほかの文）を、Claude が読んだか。担当は、終わりのコメントの「読み始め:」の時刻より前のコメントを
  // 読んでいる（前の形の終わりのコメントは書いた時刻）。対話作業の issue は開発機の対話のセッションが読んでから書くので、Claude のコメントがあれば
  // それより前を読んでいる。閉じたあとの文だけを数える（閉じるときに一緒に書いた文は、閉じる決定の一部）。
  const at = (n) => Date.parse(n.createdAt);
  // 作る担当が最後に終わった時刻（変異テストの生き残りを見たあとか）。実行の一覧は近ごろの分しか無いので、issue に残る終わりのコメントで判じる。
  const made = Math.max(0, ...nodes.filter((n) => END.exec(norm(n.body))?.[1] === "作る").map(at));
  const by = (n, login) => n.author?.login === login;
  const types = i.timelineItems.nodes.map((e) => e.prevIssueType?.name ?? null); // 今より前の種類（古い順）
  const dialog = dialogOf(config, types, i.issueType?.name ?? null);
  const reads = nodes.filter((n) => by(n, config.claude) && (dialog || END.test(norm(n.body))))
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
  const question = latestQuestion(comments, config.questionTemplate);
  // 子は、親が閉じて開き直されないなら（要望が満たされた・やめた）生きていない。条件が残ったまま完成で閉じた親は、ゲートが開き直す。
  const p = i.parent;
  const dead = Boolean(p) && p.state === "CLOSED" && !(p.stateReason === "COMPLETED" && remaining(p.body).length);
  // 見送りの相手で続けるかを問うたか。最近のコメントに無ければ、さかのぼって全部のコメントを探す（答えたあとに問い直さない）。
  const task = taskOf(config, i);
  const asking = task.dropped.length ? droppedQuestion(task.dropped) : null;
  const droppedAsked = Boolean(asking) && (comments.some((x) => x.includes(asking)) || (await allComments(gh, config, number)).some((x) => x.includes(asking)));
  return { ...task, droppedAsked, unread, answerRead, answerApplied, number, id: i.id, closedAs: i.stateReason, author: i.author?.login, body: i.body,
    conditions: conditions(i.body), remaining: remaining(i.body), assignees: i.assignees.nodes.map((a) => a.login), question,
    runs: held, parent: p && { number: p.number }, dead, children: i.subIssues.nodes, origin: Number(/^分割元: #(\d+)\s*$/m.exec(norm(i.body))?.[1]) || null,
    types, dialog,
    merged: Boolean(merged), mergeChecks: ROLLUP[merged?.mergeCommit?.statusCheckRollup?.state],
    badQuestion: last && isQuestion(last) ? checkQuestion(config.questionTemplate, last) : [], comments,
    pr: open && { id: open.id, draft: open.isDraft, checks, newSurvivors: mutants.count > 0 && !(made > mutants.at), backToDraft: Boolean(drafted && drafted > head.commit.committedDate) } };
}
