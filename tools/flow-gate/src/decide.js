// タスクのあるべき姿を、事実だけから1つの決め方で決める。GitHub に触れない。facts は src/facts.js: readFacts が組む。
// 決め方は2階: 1階（status・table・waiting）が成果物の事実と関係性からステータス（次に結果を出す者の行為）を決め、2階（owner）がその結果だけを
// 読んで担当者（ボールの持ち主）を決める。2階は前提や日時を読み直さない。見回りも、振り出すかを1階の結果（dispatchKind）で決める。
// ライフサイクル（docs/conventions/flow.md「issue のライフサイクル」）: issue は自分の約束（完了の条件と、作る側の完了の定義）が全部果たされたら終わる。
// 担当の実行は、状態か約束のどちらかを動かして終わる。どちらも動かさずに終わったらイレギュラーとしてユーザーに渡す。
// 返すのは、ゲートが保つ値の全部（ステータス・欄「実行の status」・開き閉じ・種類・担当者・本文・問いのラベル・PR をレビュー可能にするか・出す問い・
// 取り消す実行）。ゲートは今の値と違う所だけを書くので、同じ事実からは何度決めても同じになる。
import { APPLIED, checkLines, droppedOf, questionLabel, splitBody, withButton } from "./questions.js";

const WAIT = ["回答", "保留"]; // ユーザーの番（担当者の欄にユーザーを入れる）
const DIALOG = ["実装", "待機", ...WAIT, "完了"]; // 対話作業のステータス（検査・検証は開発機のセッションの中で済ませる）
const DISPATCH = ["実装", "検証"]; // 振り出す担当の種類（ステータスの値と同じ名前）

// 1階の待ち: 関係性で待つもの（前提・子が開いている・着手可能日時が先・親が保留か閉じた）。
const waiting = (f) => f.blocked || f.future || f.held;
// 振り出す担当の種類（無ければ null。src/patrol.js が読む）。1階の結果に従い、待っているもの・対話作業・開発機のセッションが触っているもの・
// 担当の付いたものは振り出さない。
export const dispatchKind = (f, config) =>
  (f.open && !f.runs.length && !f.dev && !waiting(f) && f.type !== config.dialogType && DISPATCH.includes(f.status) ? f.status : null);

export function decide(f, config) {
  // 種類は作るときに決まり、対話作業の境目をまたいで変わらない。境目の向こうへ変わったら、こちら側の最後の種類へ戻す。
  const mine = (t) => (t === config.dialogType) === f.dialog;
  const type = mine(f.type) ? f.type : (f.types.findLast(mine) ?? (f.dialog ? config.dialogType : null));
  const question = f.question && !f.question.answer && stale(f, f.question) ? null : f.question;
  const s = status({ ...f, question }, config);
  if (f.dialog && !DIALOG.includes(s.status)) s.status = "実装";
  const body = checkLines(f.body, s.check ?? []);
  // 見送りで閉じる・閉じた issue の開いた PR は、もう確かめもマージもしないので閉じる。
  const dropping = (s.closeAs ?? (f.open ? null : f.closedAs)) === "NOT_PLANNED";
  // 答えの無い問いがある間（回答のボタンを置く間）は、その問いの種類（いま出す問いがあればその種類）をラベルで見せる。
  const asking = s.status === "回答" || (s.status !== "完了" && question && !question.answer);
  const kind = s.ask ? (s.ask.dropped ? "判断" : s.ask) : question?.kind;
  return { type, status: s.status, run: runStatus(f, s.status), open: s.status !== "完了", closeAs: s.closeAs, ask: s.ask ?? null, cancel: s.cancel ?? [],
    closePr: dropping && f.pr ? f.pr.id : null, notice: [notice(f, s.status), s.told].filter(Boolean).join("\n\n") || null,
    ready: s.status === "検証" && Boolean(f.pr?.draft), assignees: owner(s.status, f, config),
    questionLabel: asking && kind ? questionLabel(kind) : null, body: asking ? withButton(body, config, f.number) : body };
}

// 欄「実行の status」: ステータスが指す種類の、動いている実行の status（GitHub の値のまま。無ければ null）。検査は、終わりから最も遠い
// 検査の実行の status（必須の検査が1本になるまでの暫定。tasks#810）。
function runStatus(f, status) {
  if (status === "検査") return (f.pr ? f.pr.stage : f.mergeStage)?.toLowerCase() ?? null;
  const r = DISPATCH.includes(status) ? f.latest[status] : null;
  return r?.active ? r.status : null;
}

// 答えの無い問いを出した事実が、あとの事実で無くなったか（無くなった問いは読まず、表で決め直す）。採否と Claude の判断の問いは、
// ゲートが読める事実から出ていない（ゲートは問いの中身を読まない）ので、答えるまで読む。
function stale(f, q) {
  if (q.kind === "確かめ") return f.remaining.some((c) => c.verify !== "ユーザー"); // 残りが確かめだけでなくなった
  if (q.kind === "イレギュラー") return f.prMoved > q.at; // 手放したあとに、作業ブランチの PR が開かれたかマージされた
  return Boolean(droppedOf(q.text)?.some((n) => !f.dropped.includes(n))); // 見送りだった相手が見送りでなくなった
}

// 2階: 担当者は2択。ユーザーに問わないと進めない（回答・保留）ならユーザー、ほかは Claude（完了は持ち主なし）。対話作業は開発機のセッションが
// 進め、それはユーザーが開いたときにしか動かないので、ラベル「開発機で作業中」が無い間はユーザー。
const owner = (status, f, config) =>
  (status === "完了" ? [] : WAIT.includes(status) || (f.dialog && !f.dev) ? [config.user] : [config.claude]);

// 受け入れなかった書き込みは、黙らずに1つのコメントで知らせる（形に合わない問い・印の間の見知らぬ行・形の合わない着手可能日時・
// 事実へ戻したユーザーのボードの移動）と、親が閉じたので閉じた子の理由。最新のコメントが同じ知らせなら書かない。
function notice(f, status) {
  const text = [f.badQuestion.length && `この問いは形に合わないので、問いとして読みません: ${f.badQuestion.join("・")}`,
    splitBody(f.body).foreign.length && "本文の先頭の印の間に、ゲートの書かない行があったので、消さずに印の外へ出しました。",
    // 直るまで続く知らせは、最近のコメントに同じ知らせがあれば重ねない（値が変われば新しく知らせる）。
    f.badStart && !f.comments.some((c) => c.includes(`「${f.badStart}」`)) &&
      `着手可能日時「${f.badStart}」の形が合わないので受け付けず、その間は振り出しません（\`YYYY-MM-DD HH:MM\` か \`YYYY-MM-DD\`。日本時間）。`,
    f.moved && f.status && status !== f.status && `ステータスを「${f.status}」にしましたが、事実から「${status}」に戻しました（ユーザーが直接決められるのは、保留と、完了（完了の条件が全部済んだときの完成か、見送り）だけです）。`,
    f.dead && f.open && `親 #${f.parent.number} が閉じたので、見送りで閉じます。`,
  ].filter(Boolean).join("\n\n");
  return text && text !== f.comments.at(-1) ? text : null;
}

function status(f, config) {
  // 完了は、完成（完了の条件が全部済んだ）か見送りでだけ受ける。条件が残ったまま完成で閉じたら、誰が閉じても開き直して決め直す。
  // ボードで完了へ動かしても、開いているなら下で事実から決め直す。
  if (!f.open && !f.unread && !(f.closedAs === "COMPLETED" && f.remaining.length)) return { status: "完了" };
  // 子は、親の要望が満たされた・やめたら、要らない。持っている実行も取り消す。
  if (f.dead) return { status: "完了", closeAs: "NOT_PLANNED", cancel: f.runs.map((r) => r.id) };
  // 持たれている間は決め直さない。ユーザーが保留へ置いたら、持っている実行を取り消す。1つのタスクを触るのは1者だけなので、同じ issue の実行が
  // 2本以上あれば（振り出した直後で一覧にまだ出ていない間に、もう一度振り出した等）、いちばん古いものを残してほかを取り消す。
  if (f.runs.length) return f.status === "保留" ? { status: "保留", cancel: f.runs.map((r) => r.id) }
    : { status: f.runs.some((r) => r.kind === "実装") ? "実装" : "検証", cancel: f.runs.slice(1).map((r) => r.id) };
  if (f.status === "保留") return { status: "保留" }; // ユーザーが置いた保留は、ユーザーが出すまで保つ
  // 入口: Claude が起こした要望だけ、採否を一度問う。子と分割したものは、採否を親か分割元から受け継ぐ。
  if (!f.adoptAsked && f.author === config.claude && f.type === "要望" && !f.parent && !f.origin) return { status: "回答", ask: "採否" };
  // ユーザーが書いた文（答えの文・コメント）を Claude がまだ読んでいなければ、Claude の番にする（閉じていれば開き直す）。ゲートは文の中身を読まない。
  if (f.unread) return { status: "実装" };
  // 答えの無い問いがあっても、完了の条件が全部済んだら完成にする（済んだ作業への問いは要らない）。採否は、条件が済んでいても着手するかの答えが要る。
  const q = f.question;
  if (q && !q.answer) {
    const t = table(f);
    return t.status === "完了" && q.kind !== "採否" ? t : { status: "回答" };
  }
  // 答えは、書いた文があれば Claude が読んだあとに当て、当てたことを一度だけ知らせる。答えのあとにユーザーがステータスを変えたか開き直したら、
  // 次の決定はそちらなので、その答えは当てない。
  const a = q?.answer;
  if (!a || f.superseded || (a.text && !f.answerRead)) return redo(f, table(f));
  const told = a.text && !f.answerApplied ? `${APPLIED}（${a.decision}）。` : null;
  if (a.decision === "見送り") return { status: "完了", closeAs: "NOT_PLANNED", told };
  if (a.decision === "保留") return { status: "保留", told };
  if (q.kind !== "確かめ" || a.decision !== "完了") return { ...redo(f, table(f)), told };
  const ok = f.remaining.filter((c) => c.verify === "ユーザー" && a.confirmed.includes(c.text));
  return { ...table({ ...f, remaining: f.remaining.filter((c) => !ok.includes(c)) }), check: ok.map((c) => c.index), told };
}

// イレギュラーに「やり直す」と答えたら、答えのあとに担当が終わるまで振り出せる形に保つ（検査は見回りが振り出さないので、
// 実装担当へ渡す。答えを当てた1回だけにすると、枠が埋まっていて振り出せないうちに次の決め直しで検査へ戻る）。
const redo = (f, t) => (f.redo && t.status === "検査" ? { ...t, status: "実装" } : t);

// 次に結果を出すのが担当でも、待つ相手（着手可能日時・親の保留か閉じ）がある間は、担当は作らないので待機。
const held = (f, t) => (DISPATCH.includes(t.status) && waiting(f) ? { ...t, status: "待機" } : t);

const IRREGULAR = { status: "回答", ask: "イレギュラー" };
// 検査の実行が1本も無いと、検査の持ち主がいない。担当が手放したあとなら止まるのでイレギュラー（PR の検査が出る形で push し、マージのあとの検査が
// 出たことを確かめるのは担当の責務。.claude/skills/task-work/SKILL.md）。
const noChecks = (f) => (f.ended ? IRREGULAR : { status: "検査" });
const afterMerge = (f) => (!f.mergeChecks ? noChecks(f) : f.mergeChecks === "FAILURE" ? { status: "実装" } : { status: "検査" });

// 1階: 成果物の事実と関係性から、次に結果を出す者の行為を決める（上から最初に当たる行）。次に結果を出すのが、いま手放した担当と
// 同じ種類のまま（状態が動かず）、その実行で約束も動いていなければ、担当は責務を果たさずに終えた。
const table = (f) => {
  const t = held(f, rows(f));
  return f.ended && !f.ended.moved && t.status === f.ended.kind ? IRREGULAR : t;
};
function rows(f) {
  const pr = f.pr;
  if (pr) {
    if (pr.backToDraft) return { status: "実装" }; // 検証担当の差し戻し
    if (!pr.checks) return noChecks(f);
    if (pr.checks === "PENDING") return { status: "検査" }; // 下書きかどうかによらず、検査の結果を待つ間は手放す
    if (pr.checks === "FAILURE") return { status: "実装" };
    return { status: "検証" };
  }
  // 待つ相手（前提・子）が開いている間は、確かめも完了もしない。見送りで閉じた相手がいれば、続けるかを一度だけ問う。
  if (f.blocked) return { status: "待機" };
  if (f.dropped.length && !f.droppedAsked) return { status: "回答", ask: { dropped: f.dropped } };
  // 作る側の完了（マージのコミットの検査が通り、本番に出た）も約束のうち。マージのあとの残りは、本番に出てから扱う（本番に出る前に確かめを問わない。原則2）。
  if (f.merged && f.mergeChecks !== "SUCCESS") return afterMerge(f);
  if (!f.remaining.length) return { status: "完了", closeAs: "COMPLETED" };
  if (f.remaining.every((c) => c.verify === "ユーザー")) return { status: "回答", ask: "確かめ" };
  return { status: "実装" };
}
