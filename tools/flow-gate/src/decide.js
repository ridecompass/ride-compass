// タスクのあるべき姿を、事実だけから1つの決め方で決める。GitHub に触れない。facts は src/facts.js: readFacts が組む。
// 決め方は2階: 1階（status・table・waiting）が成果物の事実と関係性からステータス（次に結果を出す者の行為）を決め、2階（owner）がその結果だけを
// 読んで担当者（ボールの持ち主）を決める。2階は前提や日時を読み直さない。見回りも、振り出すかを1階の結果（dispatchKind）で決める。
// ライフサイクル（docs/conventions/flow.md「issue のライフサイクル」）: issue は自分の約束（完了の条件と、作る側の完了の定義）が全部果たされ、
// 本文の「やること」の項目が全部行き先を名指したら終わる。
// 担当の実行は、状態か約束のどちらかを動かして終わる。どちらも動かさずに終わったらイレギュラーとしてユーザーに渡す。
// 返すのは、ゲートが保つ値の全部（ステータス・欄「実行の status」・開き閉じ・種類・担当者・本文・問いのラベル・PR をレビュー可能にするか・出す問い・
// 取り消す実行）。ゲートは今の値と違う所だけを書くので、同じ事実からは何度決めても同じになる。
import { APPLIED, droppedOf, questionLabel, splitBody, withButton } from "./questions.js";

// 読むのに要求の要る事実（src/facts.js: readFacts の later）は、決め方が使うときだけ読む。まだ読んでいなければ Need を投げ、src/gate.js: settle が
// 読んでから決め直す（決め方の順番を、事実を読む側に写さない）。
export class Need extends Error {
  constructor(fact) {
    super(fact);
    this.fact = fact;
  }
}
const need = (f, fact) => {
  if (f[fact] === undefined) throw new Need(fact);
  return f[fact];
};

const WAIT = ["回答", "保留"]; // ユーザーの番（担当者の欄にユーザーを入れる）
const DISPATCH = ["実装", "検証"]; // 振り出す担当の種類（ステータスの値と同じ名前）

// 1階の待ち: 関係性で待つもの（前提・子が開いている・着手可能日時が先・親が保留か閉じた）。
const waiting = (f) => f.blocked || f.future || f.held;
// 2階: 持ち主（次に結果を出す者）。担当者と振り出しは、どちらもここから導く。ユーザーに問わないと進めない間（回答・保留）はユーザー、
// 検査・待機は事実が動くのを待つ（担当者は Claude）。実装・検証は、対話作業と開発機のセッションが触っている issue なら開発機のセッションが
// 進め（ユーザーが開いたときにしか動かないので、ラベル「開発機で作業中」が無い間はユーザー）、ほかは担当。完了は持ち主なし。
function holder(status, f) {
  if (status === "完了") return null;
  if (WAIT.includes(status)) return "ユーザー";
  if (!DISPATCH.includes(status)) return "Claude"; // 検査・待機は事実が動くのを待つ
  return f.dialog || f.dev ? (f.dev ? "開発機" : "ユーザー") : "担当";
}
const owner = (status, f, config) => {
  const h = holder(status, f);
  return h === null ? [] : h === "ユーザー" ? [config.user] : [config.claude];
};
// 振り出す担当の種類（無ければ null。src/patrol.js が読む）。持ち主が担当で、担当の実行がまだ無いもの。見回りが読むステータスは前に決めた値
// なので、待つ相手（1階の待ち）を今の事実で当て直してから見る。
export const dispatchKind = (f) => (f.open && !f.runs.length && holder(held(f, { status: f.status }).status, f) === "担当" ? f.status : null);

export function decide(f, config) {
  // 種類は作るときに決まり、対話作業の境目をまたいで変わらない。境目の向こうへ変わったら、こちら側の最後の種類へ戻す。
  const mine = (t) => (t === config.dialogType) === f.dialog;
  const type = mine(f.type) ? f.type : (f.types.findLast(mine) ?? (f.dialog ? config.dialogType : null));
  const question = f.question && !f.question.answer && !alive(f, f.question, config) ? null : f.question;
  const s = status({ ...f, question }, config);
  const body = splitBody(f.body).rest;
  // 見送りで閉じる・閉じた issue の開いた PR は、もう確かめもマージもしないので閉じる。
  const dropping = (s.closeAs ?? (f.open ? null : f.closedAs)) === "NOT_PLANNED";
  // 答えの無い問いがある間（回答のボタンを置く間）は、その問いのラベル（いま出す問いがあればそのラベル）をラベルで見せる。
  const asking = s.status === "回答" || (s.status !== "完了" && question && !question.answer);
  const kind = s.ask ? (s.ask.dropped ? "続行" : s.ask) : question?.kind;
  return { type, status: s.status, run: runStatus(f, s.status), open: s.status !== "完了", closeAs: s.closeAs, ask: s.ask ?? null, cancel: s.cancel ?? [],
    closePr: dropping && f.pr ? f.pr.id : null, notice: [notice(f, s.status, config), s.told].filter(Boolean).join("\n\n") || null,
    ready: s.status === "検証" && Boolean(f.pr?.draft), assignees: owner(s.status, f, config),
    questionLabel: asking && kind ? questionLabel(kind) : null, body: asking ? withButton(body, config, f.number) : body };
}

// 欄「実行の status」: ステータスが指す種類の、動いている実行の status（GitHub の値のまま。無ければ null）。検査は、最も新しい検査の実行の status。
function runStatus(f, status) {
  if (status === "検査") return (f.pr ? f.pr.checks : mergeChecks(f)).stage.toLowerCase(); // 検査は走っている実行があるときだけ
  return f.runs.find((r) => r.kind === status)?.status ?? null;
}

// 答えの無い問いが生きているか。ゲートが出した問いは、同じ事実から決め直して同じ問いが出る間だけ生きる（その問いを一度問うたこと・担当の実行・
// 保留・読まれていない文は、問いを出す事実に数えない。ほかの問いを問うたことは数える）。無くなった問いは読まず、表で決め直す。担当が出した問いは、
// ゲートが中身を読まないので答えるまで生きる。
function alive(f, q, config) {
  if (q.form?.by !== "ゲート") return true;
  if (q.form.text && q.text !== q.form.text) return false; // 決まった文が変わった問いは、今の文で問い直す
  const dropped = droppedOf(q.text);
  const once = { ...(q.kind === "採否" && { adoptAsked: false }), ...(dropped && { droppedAsked: false }) };
  const s = status({ ...f, ...once, question: null, unread: false, runs: [], status: null }, config);
  return dropped ? String(s.ask?.dropped?.toSorted()) === String(dropped.toSorted()) : s.ask === q.kind;
}

// 受け入れなかった書き込みは、黙らずに1つのコメントで知らせる（形に合わない問い・印の間の見知らぬ行・形の合わない着手可能日時・
// 事実へ戻したユーザーのボードの移動）と、行き先の無い「やること」で閉じなかった理由と、親が閉じたので閉じた子の理由と、長く動いていない
// 前提の対話作業。最新のコメントが同じ知らせなら書かない。
function notice(f, status, config) {
  const text = [f.badQuestion.length && `この問いは形が外れているので、回答フォームは回答内容を出さずに、書く欄と次遷移だけで答えを受けます: ${f.badQuestion.join("・")}`,
    splitBody(f.body).foreign.length && "本文の先頭の印の間に、ゲートの書かない行があったので、消さずに印の外へ出しました。",
    // 直るまで続く知らせは、最近のコメントに同じ知らせがあれば重ねない（値が変われば新しく知らせる）。
    f.badStart && !f.comments.some((c) => c.includes(`「${f.badStart}」`)) &&
      `着手可能日時「${f.badStart}」は暦にある日時として読めないので受け付けず、その間は振り出しません（\`YYYY-MM-DD HH:MM\` か \`YYYY-MM-DD\`。日本時間）。`,
    f.moved && f.status && status !== f.status && `ステータスを「${f.status}」にしましたが、事実から「${status}」に戻しました（ユーザーが直接決められるのは、保留と、完了（完了の条件が全部済んだときの完成か、見送り）だけです）。`,
    status === "実装" && !f.remaining.length && f.unbound.length && !f.comments.some((c) => c.includes(unboundText(f.unbound))) &&
      `${unboundText(f.unbound)}ので、完了の条件が全部済んでも完成で閉じず、実装担当へ渡します（\`- 行き先: 完了の条件「<条件の文の頭>」\`・\`#<番号>\`・\`見送り（<理由>）\`）。`,
    f.dead && f.open && `親 #${f.parent.number} が閉じたので、見送りで閉じます。`,
    // 担当者は Claude なので、ユーザーへ届くようにメンションする。
    status === "待機" && f.idle.length && !f.comments.some((c) => c.includes(idleText(f.idle, config))) &&
      `@${config.user} ${idleText(f.idle, config)}。対話作業を終えたなら閉じてください（閉じるまで、このタスクは待ったまま振り出しません）。`,
  ].filter(Boolean).join("\n\n");
  return text && text !== f.comments.at(-1) ? text : null;
}

const unboundText = (names) => `本文の「やること」の ${names.join("・")} が行き先を名指していない`;
const idleText = (idle, config) => `前提の対話作業 ${idle.map((n) => `#${n}`).join("・")} が ${config.dialogIdleHours} 時間より長く動いていません`;

// 入口で採否を問う issue: Claude が起こした要望。子と分割元のある切り出しは、採否を親か元から受け継ぐ。
export const adoptable = (f, config) => f.author === config.claude && f.type === "要望" && !f.parent && !f.origin;

function status(f, config) {
  // 完了は、完成（完了の条件が全部済んだ）か見送りでだけ受ける。条件が残ったまま完成で閉じたら、誰が閉じても開き直して決め直す。
  // ボードで完了へ動かしても、開いているなら下で事実から決め直す。
  if (!f.open && !f.unread && !(f.closedAs === "COMPLETED" && f.remaining.length)) return { status: "完了" };
  // 子は、親の要望が満たされた・やめたら、要らない。持っている実行も取り消す。
  if (f.dead) return { status: "完了", closeAs: "NOT_PLANNED", cancel: f.runs.map((r) => r.id) };
  // 約束が全部果たされたら、どの時点でも完了（PR・前提・子・担当の実行・マージの検査に関係なく）。ユーザーが置いた保留と、Claude がまだ読んで
  // いないユーザーの文（答えの文・コメント）は待つ。動いている担当の実行は要らないので取り消す。本文の「やること」に行き先を名指していない
  // 項目が残る間は、手を付けずに残った項目が消えないよう閉じない（下の rows で実装担当へ渡す）。
  if (!f.remaining.length && !f.unbound.length && f.status !== "保留" && !f.unread) return { status: "完了", closeAs: "COMPLETED", cancel: f.runs.map((r) => r.id) };
  // 持たれている間は決め直さない。ユーザーが保留へ置いたら、持っている実行を取り消す。1つのタスクを触るのは1者だけなので、同じ issue の実行が
  // 2本以上あれば（振り出した直後で一覧にまだ出ていない間に、もう一度振り出した等）、いちばん古いものを残してほかを取り消す。
  if (f.runs.length) return f.status === "保留" ? { status: "保留", cancel: f.runs.map((r) => r.id) }
    : { status: f.runs.some((r) => r.kind === "実装") ? "実装" : "検証", cancel: f.runs.slice(1).map((r) => r.id) };
  if (f.status === "保留") return { status: "保留" }; // ユーザーが置いた保留は、ユーザーが出すまで保つ
  // 入口: 採否を問う issue（adoptable）には、一度だけ問う。
  if (adoptable(f, config) && !need(f, "adoptAsked")) return { status: "回答", ask: "採否" };
  // ユーザーが書いた文（答えの文・コメント）を Claude がまだ読んでいなければ、Claude の番にする（閉じていれば開き直す）。ゲートは文の中身を読まない。
  if (f.unread) return { status: "実装" };
  // 答えの無い問いは、答えを待つ。
  const q = f.question;
  if (q && !q.answer) return { status: "回答" };
  // 答えは、書いた文があれば Claude が読んだあとに当て、当てたことを一度だけ知らせる。答えのあとにユーザーがステータスを変えたか開き直したら、
  // 次の決定はそちらなので、その答えは当てない。
  const a = q?.answer;
  if (!a || (a.text && !f.answerRead) || (["保留", "見送り"].includes(a.decision) && need(f, "superseded"))) return table(f);
  const told = a.text && !f.answerApplied ? `${APPLIED}（${a.decision}）。` : null;
  if (a.decision === "見送り") return { status: "完了", closeAs: "NOT_PLANNED", told };
  if (a.decision === "保留") return { status: "保留", told };
  // 続けるの遷移先は Claude: 答え（回答内容）を Claude が読むまでは実装。
  return f.answerRead ? { ...table(f), told } : { status: "実装", told };
}

// 次に結果を出すのが担当でも、待つ相手（着手可能日時・親の保留か閉じ）がある間は、担当は作らないので待機。
const held = (f, t) => (DISPATCH.includes(t.status) && waiting(f) ? { ...t, status: "待機" } : t);

// 検査は、走っている間は検査、合格していなければ（不合格か、検査の実行が1本も無い）実装（検査が始まる形で push するのも、直すのも実装担当）。
// マージのコミットの検査。自分の実行が取り消されたら、その変更を判定に入れる後の master の実行（src/facts.js: readFacts の covering）で読む。
const mergeChecks = (f) => (f.mergeChecks.cancelled && need(f, "covering")) || f.mergeChecks;
const unchecked = (c) => ({ status: c.stage && c.stage !== "COMPLETED" ? "検査" : "実装" });

// 1階: 成果物の事実と関係性から、次に結果を出す者の行為を決める（上から最初に当たる行）。次に結果を出すのが、いま手放した担当と
// 同じ種類のまま（状態が動かず）、その実行で約束も動いていなければ、担当は責務を果たさずに終えた。
const table = (f) => {
  const t = held(f, rows(f));
  return f.ended && t.status === f.ended.kind && !need(f, "ranMoved") ? { status: "回答", ask: "イレギュラー" } : t;
};
function rows(f) {
  // 約束が全部果たされても閉じなかった（「やること」に行き先の無い項目が残る）なら、行き先を書くのは実装担当。
  if (!f.remaining.length) return { status: "実装" };
  const pr = f.pr;
  if (pr) {
    // 検証担当の差し戻しと、master とのぶつかり（取り込むのは実装担当。検証担当はマージの手前で当たって差し戻すだけになる）。
    if (pr.backToDraft || pr.conflicting) return { status: "実装" };
    return pr.checks.passed ? { status: "検証" } : unchecked(pr.checks); // 下書きかどうかによらず、検査の結果を待つ間は手放す
  }
  // 待つ相手（前提・子）が開いている間は、確かめも完了もしない。見送りで閉じた相手がいれば、続けるかを一度だけ問う。
  if (f.blocked) return { status: "待機" };
  if (f.dropped.length && !need(f, "droppedAsked")) return { status: "回答", ask: { dropped: f.dropped } };
  // 作る側の完了（マージのコミットの検査が通り、本番に出た）も約束のうち。マージのあとの残りは、本番に出てから扱う（本番に出る前に確かめを問わない。原則2）。
  if (f.merged && !mergeChecks(f).passed) return unchecked(mergeChecks(f));
  if (f.remaining.every((c) => c.verify === "ユーザー")) return { status: "回答", ask: "確かめ" };
  return { status: "実装" };
}
