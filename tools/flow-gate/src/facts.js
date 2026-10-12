// タスクの事実を読む（src/decide.js: decide が受ける形）。置き場の issue・書くのに要る ID（種類・ラベル）・コードのリポジトリの作業ブランチの PR と
// 検査を GraphQL の1回で、担当の実行は Actions の実行の一覧から読む。ゲートは issue の情報を持たない（持ち主は GitHub）。見回りの一覧も同じ読み方を使う。
import { FIELDS, START_FORM, valuesOf } from "./fields.js";
import { pages } from "./github.js";
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
  const waits = [...issue.blockedBy.nodes, ...issue.subIssues.nodes];
  const labels = (i) => i.labels.nodes.map((l) => l.name);
  return { status: own[f.status.name], run: own[f.run.name], priority: from[f.priority.name], type: issue.issueType?.name ?? null,
    open: issue.state === "OPEN", blocked: waits.some((w) => w.state === "OPEN"), dropped: waits.filter(dropped).map((w) => w.number),
    future: Boolean(text) && (!start || start > now), badStart: mine && !jst(mine) ? mine : null,
    urgent: labels(parent ?? issue).includes(config.urgentLabel), held: Boolean(parent) && (parent.state === "CLOSED" || from[f.status.name] === "保留"),
    labels: labels(issue), dev: labels(issue).includes(config.devLabel), assignees: issue.assignees.nodes.map((a) => a.login) };
}
export const jstText = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // 日本時間の「YYYY-MM-DD HH:MM」
// 担当の実行の名前「#<番号> <種類> <振り出しの識別子>」（claude-task.yml の run-name。手で起こした実行は識別子が無い）。
export function runOf(title) {
  const [, number, kind, key] = /^#(\d+) (\S+)(?: (\S+))?/.exec(title) ?? [];
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
const query = () => `query($to:String!,$tn:String!,$n:Int!,$co:String!,$cn:String!,$head:String!){
 t:repository(owner:$to,name:$tn){issueTypes(first:20){nodes{id name}} labels(first:100){nodes{id name}}
  issue(number:$n){id state stateReason closedAt body author{login} issueType{name} assignees(first:10){nodes{login}} labels(first:20){nodes{name}}
  comments(last:40){totalCount nodes{body createdAt author{login}}} ${FIELDS} ${relationsOf(true)} blocking(first:20){nodes{number state}}
  timelineItems(first:50,itemTypes:[ISSUE_TYPE_CHANGED_EVENT]){nodes{...on IssueTypeChangedEvent{prevIssueType{name} issueType{name}}}}}}
 c:repository(owner:$co,name:$cn){pullRequests(headRefName:$head,first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{
  id state isDraft merged createdAt mergedAt mergeCommit{${SUITES}} commits(last:1){nodes{commit{committedDate ${SUITES}}}}
  timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}}}}}`;

// 検査の実行の status の、終わりから遠い順（GitHub の値）。
const STAGES = ["REQUESTED", "QUEUED", "WAITING", "PENDING", "IN_PROGRESS", "COMPLETED"];
// 合格の結論（GitHub が必須の検査の合格に数えるもの: 成功・スキップ・中立）。
const PASSED = ["SUCCESS", "SKIPPED", "NEUTRAL"];
// コミットの検査の実行（ワークフローの実行の無い suite は数えない）。stage は終わりから最も遠い実行の status（実行が無ければ null）、
// passed は実行があって全部が合格したか（終わっていない実行は結論を持たないので合格しない）。
function checksOf(commit) {
  const runs = (commit?.checkSuites.nodes ?? []).filter((s) => s.workflowRun);
  return { stage: STAGES.find((s) => runs.some((r) => r.status === s)) ?? null, passed: runs.length > 0 && runs.every((r) => PASSED.includes(r.conclusion)) };
}

// issue の全部のコメントの本文（古い順）。
const allComments = async (gh, config, number) => (await Array.fromAsync(pages(gh, `query($o:String!,$r:String!,$n:Int!,$a:String){repository(owner:$o,name:$r){issue(number:$n){
  comments(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{body}}}}}`, { ...repo(config.tasks), n: number }, (d) => d.repository.issue.comments))).map((c) => norm(c.body));
const repo = (full) => ({ o: full.split("/")[0], r: full.split("/")[1] });

// since より後に、ユーザーがステータスを変えたか開き直したか（時系列を、見つかるまでページを送って読む）。
async function movedSince(gh, config, number, since) {
  for await (const e of pages(gh, `query($o:String!,$r:String!,$n:Int!,$s:DateTime!,$a:String){repository(owner:$o,name:$r){issue(number:$n){
    timelineItems(since:$s,first:100,after:$a,itemTypes:[ISSUE_FIELD_ADDED_EVENT,ISSUE_FIELD_CHANGED_EVENT,REOPENED_EVENT]){pageInfo{hasNextPage endCursor} nodes{
     ...on IssueFieldAddedEvent{actor{login} issueField{...on IssueFieldSingleSelect{name}}} ...on IssueFieldChangedEvent{actor{login} issueField{...on IssueFieldSingleSelect{name}}}
     ...on ReopenedEvent{actor{login}}}}}}}`, { ...repo(config.tasks), n: number, s: since }, (d) => d.repository.issue.timelineItems))
    if (e.actor?.login === config.user && (!e.issueField || e.issueField.name === config.fields.status.name)) return true;
  return false;
}

// 担当の終わりのコメントの見出しと、読み始めの完了の条件の見出し（.github/claude-task/after.js が書く）。
export const END = /^### (\S+)担当の終わり/;
const START = "\n読み始めの完了の条件:\n";
// 最後に終わった担当（種類・読み始めの時刻・読み始めの完了の条件）。終わりのあとに問いが出ていれば、その終わりは問いの側で扱ったので null。
function endedOf(nodes) {
  const k = nodes.findLastIndex((n) => END.test(norm(n.body)));
  if (k < 0 || nodes.slice(k + 1).some((n) => isQuestion(n.body))) return null;
  const body = norm(nodes[k].body);
  const at = body.indexOf(START);
  return { kind: END.exec(body)[1], from: /^読み始め: (\S+)$/m.exec(body)?.[1] ?? nodes[k].createdAt, before: at < 0 ? null : conditions(body.slice(at + START.length)) };
}
// その実行で約束が動いたか: 読み始めより今のチェックが多いか、読み始めの行のうち今の本文に無い行が、全部その実行の間にできた移管先（子・兄弟・
// この issue を指す issue）の条件にある。消えた行があるときだけ移管先を読む（要求1回）。読み始めの条件が無ければ動いていない。
async function movedOf(gh, config, number, ended, now) {
  const done = (list) => list.filter((c) => c.done).length;
  if (!ended.before) return false;
  if (done(now) > done(ended.before)) return true;
  const gone = ended.before.filter((c) => !now.some((x) => x.text === c.text));
  if (!gone.length) return false;
  const { repository: { issue: i } } = await gh.gql(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
    subIssues(first:50){nodes{createdAt body}} parent{subIssues(first:50){nodes{createdAt body}}}
    timelineItems(last:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{source{...on Issue{createdAt body}}}}}}}}`, { ...repo(config.tasks), n: number });
  const made = [...i.subIssues.nodes, ...(i.parent?.subIssues.nodes ?? []), ...i.timelineItems.nodes.map((x) => x.source).filter((x) => x?.body)]
    .filter((x) => Date.parse(x.createdAt) >= Date.parse(ended.from)).flatMap((x) => conditions(x.body));
  return gone.every((c) => made.some((x) => x.text === c.text));
}

// runs は出来事1件につき1回読んだ担当の実行の一覧（recentRuns）。
export async function readFacts(gh, config, number, runs) {
  const [to, tn] = config.tasks.split("/");
  const [co, cn] = config.code.split("/");
  const { t, c } = await gh.gql(query(), { to, tn, n: number, co, cn, head: `${config.branchPrefix}${number}` });
  const i = t.issue;
  const held = runs.filter((r) => r.number === number && r.active).sort((a, b) => a.created - b.created); // 古い順（2本目からは二重の実行）
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
  const latest = latestQuestion(comments, config.questionForms);
  const question = latest && { ...latest, at: at(nodes[asked]) };
  // 答えのあとに、ユーザーがステータスを変えたか開き直したら、その答えはユーザーの次の決定で置き換わった（答えを当て直さない）。
  // 当て直すと結果が変わる答え（保留・見送り）のときだけ、答えより後の時系列を読む。
  const superseded = ["保留", "見送り"].includes(latest?.answer?.decision) && (await movedSince(gh, config, number, answer.createdAt));
  // 子は、親が閉じて開き直されないなら（要望が満たされた・やめた）生きていない。条件が残ったまま完成で閉じた親は、ゲートが開き直す。
  const p = i.parent;
  const dead = Boolean(p) && p.state === "CLOSED" && !(p.stateReason === "COMPLETED" && remaining(p.body).length);
  // 一度でも出した問いか。最近のコメントに無く、それより前のコメントがあれば、さかのぼって全部を読む（答えたあとに問い直さない）。
  let older = null;
  const ever = async (has) => comments.some(has) || (i.comments.totalCount > nodes.length && (older ??= await allComments(gh, config, number)).some(has));
  const task = taskOf(config, i);
  const asking = task.dropped.length ? droppedQuestion(task.dropped) : null;
  const droppedAsked = Boolean(asking) && (await ever((x) => x.includes(asking)));
  const adoptAsked = await ever((x) => x.startsWith("## 問い（採否）"));
  const ended = endedOf(nodes);
  const byName = (list) => Object.fromEntries(list.nodes.map((x) => [x.name, x.id]));
  return { ...task, droppedAsked, adoptAsked, unread, answerRead, answerApplied, superseded, number, id: i.id, closedAs: i.stateReason, author: i.author?.login, body: i.body,
    conditions: conditions(i.body), remaining: remaining(i.body), question, ended: ended && { kind: ended.kind, moved: await movedOf(gh, config, number, ended, conditions(i.body)) },
    runs: held,
    parent: p && { number: p.number }, dead, children: i.subIssues.nodes, origin: Number(/^分割元: #(\d+)\s*$/m.exec(norm(i.body))?.[1]) || null,
    types, dialog, ids: { types: byName(t.issueTypes), labels: byName(t.labels) },
    // 閉じた・開き直したときに決め直す、矢印1本でつながる開いた issue（後・親・子）。
    near: [...i.blocking.nodes, ...(p ? [p] : []), ...i.subIssues.nodes].filter((x) => x.state === "OPEN").map((x) => x.number),
    // 作業ブランチの PR が最後に開かれたかマージされた時刻（担当が手放したあとに、別の所で作られたかを問いの時刻と比べる）。
    prMoved: Math.max(0, ...c.pullRequests.nodes.flatMap((x) => [Date.parse(x.createdAt), Date.parse(x.mergedAt) || 0])),
    merged: Boolean(merged), mergeChecks: checksOf(merged?.mergeCommit),
    badQuestion: last && isQuestion(last) ? checkQuestion(config.questionForms, last) : [], comments,
    pr: open && { id: open.id, draft: open.isDraft, checks: checksOf(head.commit), backToDraft: Boolean(drafted && drafted > head.commit.committedDate) } };
}
