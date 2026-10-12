// タスクの事実を読む（src/decide.js: decide が受ける形）。置き場の issue・書くのに要る ID（種類・ラベル）・コードのリポジトリの作業ブランチの PR と
// 検査を GraphQL の1回で、担当の実行は Actions の実行の一覧から読む。ゲートは issue の情報を持たない（持ち主は GitHub）。見回りの一覧も同じ読み方を使う。
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
// issue の欄とラベルから、欄と待ちを組む（1件を決め直すときも、振り出しの一覧も同じ）。子（親を持つ issue）は、優先度・着手可能日時・
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
  const labels = (i) => (i?.labels?.nodes ?? []).map((l) => l.name);
  return { status: own[f.status.name], run: own[f.run.name] ?? null, priority: from[f.priority.name], type: issue.issueType?.name ?? null,
    open: issue.state === "OPEN", blocked: waits.some((w) => w.state === "OPEN"), dropped: waits.filter(dropped).map((w) => w.number),
    future: Boolean(text) && (!start || start > now), badStart: mine && !jst(mine) ? mine : null,
    urgent: labels(parent ?? issue).includes(config.urgentLabel), held: Boolean(parent) && (parent.state === "CLOSED" || from[f.status.name] === "保留"),
    dev: labels(issue).includes(config.devLabel), assignees: (issue.assignees?.nodes ?? []).map((a) => a.login) };
}
export const jstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 日本時間の「YYYY-MM-DD HH:MM」
// 担当の実行の名前「#<番号> <種類> <振り出しの識別子>」（claude-task.yml の run-name。手で起こした実行は識別子が無い）。
export function runOf(title) {
  const [, number, kind, key] = /^#(\d+) (\S+)(?: (\S+))?/.exec(title ?? "") ?? [];
  return number ? { number: Number(number), kind, key } : null;
}
// 担当のワークフロー（config.workflow）の近ごろの実行（新しい順に100本）。動いているか・枠が埋まっているかは、出来事1件につき1回ここから読む。
// status は GitHub の値のまま持つ（欄「実行の status」へ写す）。
export async function recentRuns(gh, config) {
  const { workflow_runs: runs } = await gh.rest("GET", `/repos/${config.code}/actions/workflows/${config.workflow}/runs?per_page=100&exclude_pull_requests=true`);
  return runs.map((r) => ({ ...runOf(r.display_title), id: r.id, status: r.status, active: r.status !== "completed", conclusion: r.conclusion,
    created: Date.parse(r.created_at), updated: Date.parse(r.updated_at) })).filter((r) => r.number);
}

// 検査は、コミットに付いたワークフローの実行（check suite）を1本ずつ、GitHub の status と conclusion のまま読む。
const SUITES = "checkSuites(first:30){nodes{status conclusion workflowRun{databaseId}}}";
const query = () => `query($to:String!,$tn:String!,$n:Int!,$co:String!,$cn:String!,$head:String!,$base:String!){
 t:repository(owner:$to,name:$tn){issueTypes(first:20){nodes{id name}} labels(first:100){nodes{id name}}
  issue(number:$n){id state stateReason closedAt body author{login} issueType{name} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}
  comments(last:40){nodes{body createdAt author{login}}} ${FIELDS} ${relationsOf(true)} blocking(first:20){nodes{number state}}
  timelineItems(first:50,itemTypes:[ISSUE_TYPE_CHANGED_EVENT]){nodes{...on IssueTypeChangedEvent{prevIssueType{name} issueType{name}}}}}}
 c:repository(owner:$co,name:$cn){pullRequests(headRefName:$head,first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
  id state isDraft merged createdAt mergedAt mergeCommit{oid ${SUITES}} commits(last:1){nodes{commit{oid committedDate ${SUITES}}}}
  timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}}}
  ref(qualifiedName:$base){target{...on Commit{history(first:20){nodes{oid ${SUITES}}}}}}}}`;

// 検査の実行の status の、終わりから遠い順（GitHub の値）。
export const STAGES = ["REQUESTED", "QUEUED", "WAITING", "PENDING", "IN_PROGRESS", "COMPLETED"];
const FAILED = ["ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "STALE"];
// コミットの検査の実行（ワークフローの実行の無い suite は数えない）。stage は終わりから最も遠い実行の status、verdict は合否
// （1本でも終わっていなければ PENDING。終わった実行が1本でも落ちていれば FAILURE）。実行が1本も無ければ null。
export function checksOf(commit) {
  const runs = (commit?.checkSuites?.nodes ?? []).filter((s) => s.workflowRun);
  if (!runs.length) return null;
  const stage = STAGES.find((s) => runs.some((r) => r.status === s));
  const verdict = stage !== "COMPLETED" ? "PENDING" : runs.some((r) => FAILED.includes(r.conclusion)) ? "FAILURE" : "SUCCESS";
  return { stage, verdict };
}
// マージが本番に出たか。master の CI は、前のコミットで落ちた・取り消された変更も次の push の検査とデプロイに含むので、マージのコミットか、
// それより後の master のコミット（history は新しい順。マージのコミットが見えなければ全部が後）のどれかで通れば出ている。
const deployed = (merged, history) => {
  const since = history.findIndex((n) => n.oid === merged.mergeCommit?.oid);
  const after = since < 0 ? history : history.slice(0, since);
  const mine = checksOf(merged.mergeCommit);
  return after.some((n) => checksOf(n)?.verdict === "SUCCESS") ? { stage: "COMPLETED", verdict: "SUCCESS" } : mine;
};

// イレギュラーに「やり直す」と答えたあと（answered はその時刻）、まだ担当が終わっていないか（src/decide.js: redo）。issue に残るコメントで判じる。
const redo = (question, answered, ends) => question?.kind === "イレギュラー" && question.answer?.decision === "続ける" && !ends.some((t) => t > answered);

// issue の全部のコメントの本文（古い順）。
async function allComments(gh, config, number) {
  const all = [];
  for (let page = 1; ; page++) {
    const got = await gh.rest("GET", `/repos/${config.tasks}/issues/${number}/comments?per_page=100&page=${page}`);
    all.push(...got.map((x) => norm(x.body)));
    if (got.length < 100) return all;
  }
}

// 担当の終わりのコメントの見出しと、約束が動いたかの行（.github/claude-task/after.js が書く）。
export const END = /^### (\S+)担当の終わり/;
export const MOVED = "約束: 動いた";
// 最後に終わった担当（種類と、その実行で約束が動いたか）。終わりのあとに問いが出ていれば、その終わりは問いの側で扱ったので null。
function endedOf(nodes) {
  const k = nodes.findLastIndex((n) => END.test(norm(n.body)));
  if (k < 0 || nodes.slice(k + 1).some((n) => isQuestion(n.body))) return null;
  const body = norm(nodes[k].body);
  return { kind: END.exec(body)[1], moved: body.split("\n").some((l) => l.startsWith(MOVED)) };
}

// runs は出来事1件につき1回読んだ担当の実行の一覧（recentRuns）。
export async function readFacts(gh, config, number, runs) {
  const [to, tn] = config.tasks.split("/");
  const [co, cn] = config.code.split("/");
  const { t, c } = await gh.gql(query(), { to, tn, n: number, co, cn, head: `${config.branchPrefix}${number}`, base: config.base });
  const i = t.issue;
  const mine = runs.filter((r) => r.number === number);
  const held = mine.filter((r) => r.active).sort((a, b) => a.created - b.created); // 古い順（2本目からは二重の実行）
  const open = c.pullRequests.nodes.find((p) => p.state === "OPEN");
  const head = open?.commits.nodes.at(-1);
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
  const answerRead = Boolean(answer) && reads.some((x) => x > at(answer));
  const answerApplied = Boolean(answer) && nodes.some((n) => at(n) > at(answer) && norm(n.body).startsWith(APPLIED));
  const latest = latestQuestion(comments, config.questionTemplate);
  const question = latest && { ...latest, at: at(nodes[asked]) };
  // 子は、親が閉じて開き直されないなら（要望が満たされた・やめた）生きていない。条件が残ったまま完成で閉じた親は、ゲートが開き直す。
  const p = i.parent;
  const dead = Boolean(p) && p.state === "CLOSED" && !(p.stateReason === "COMPLETED" && remaining(p.body).length);
  // 見送りの相手で続けるかを問うたか。最近のコメントに無ければ、さかのぼって全部のコメントを探す（答えたあとに問い直さない）。
  const task = taskOf(config, i);
  const asking = task.dropped.length ? droppedQuestion(task.dropped) : null;
  const droppedAsked = Boolean(asking) && (comments.some((x) => x.includes(asking)) || (await allComments(gh, config, number)).some((x) => x.includes(asking)));
  const prChecks = checksOf(head?.commit);
  const mergeChecks = merged ? deployed(merged, c.ref.target.history.nodes) : null;
  const byName = (list) => Object.fromEntries(list.nodes.map((x) => [x.name, x.id]));
  return { ...task, droppedAsked, redo: redo(question, answer && at(answer), nodes.filter((n) => END.test(norm(n.body))).map(at)), unread, answerRead, answerApplied, number, id: i.id, closedAs: i.stateReason, author: i.author?.login, body: i.body,
    conditions: conditions(i.body), remaining: remaining(i.body), question, ended: endedOf(nodes),
    runs: held, latest: Object.fromEntries(mine.map((r) => [r.kind, r]).reverse()), // 種類ごとの最新の実行
    parent: p && { number: p.number }, dead, children: i.subIssues.nodes, origin: Number(/^分割元: #(\d+)\s*$/m.exec(norm(i.body))?.[1]) || null,
    types, dialog, labels: i.labels.nodes.map((l) => l.name), ids: { types: byName(t.issueTypes), labels: byName(t.labels) },
    // 閉じた・開き直したときに決め直す、矢印1本でつながる開いた issue（後・親・子）。
    near: [...i.blocking.nodes, ...(p ? [p] : []), ...i.subIssues.nodes].filter((x) => x.state === "OPEN").map((x) => x.number),
    // 作業ブランチの PR が最後に開かれたかマージされた時刻（担当が手放したあとに、別の所で作られたかを問いの時刻と比べる）。
    prMoved: Math.max(0, ...c.pullRequests.nodes.flatMap((x) => [Date.parse(x.createdAt), Date.parse(x.mergedAt) || 0])),
    merged: Boolean(merged), mergeChecks: mergeChecks?.verdict ?? null, mergeStage: mergeChecks?.stage ?? null,
    badQuestion: last && isQuestion(last) ? checkQuestion(config.questionTemplate, last) : [], comments,
    pr: open && { id: open.id, draft: open.isDraft, checks: prChecks?.verdict ?? null, stage: prChecks?.stage ?? null, backToDraft: Boolean(drafted && drafted > head.commit.committedDate) } };
}
