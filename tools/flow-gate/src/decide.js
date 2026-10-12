// タスクのあるべき姿を、事実だけから1つの決め方で決める。GitHub に触れない。facts は src/facts.js: readFacts が組む。
// 決め方は2階: 1階（status・table・waiting）が成果物の事実と関係性からステータスと「待っているか」を決め、2階（owner）がその結果だけを
// 読んで担当者（ボールの持ち主）を決める。2階は前提や日時を読み直さない。見回りも、振り出すかを1階の結果（dispatchKind）で決める。
// 返すのは、ゲートが保つ値の全部（ステータス・開き閉じ・種類・担当者・本文・ボード・PR をレビュー可能にするか・出す問い・
// 取り消す実行）。ゲートは今の値と違う所だけを書くので、同じ事実からは何度決めても同じになる。
import { APPLIED, checkLines, droppedOf, splitBody, withButton } from "./questions.js";

const HELD = { 作る: "進行中", 確かめる: "検証中" }; // 担当が持っている間のステータス
const WAIT = ["回答待ち", "保留"]; // ユーザーの番（担当者の欄にユーザーを入れる）
const DIALOG = ["未着手", ...WAIT, "完了"]; // 対話作業のステータス（開発機のセッションが触っていることは持たない）
const ACCEPTED = (k) => k.state === "CLOSED" && k.stateReason === "COMPLETED";
const DISPATCH = { 未着手: "作る", 検証待ち: "確かめる" }; // 振り出す担当の種類

// 1階の待ち: 関係性で待つもの（前提・子が開いている・着手可能日時が先・親が保留か閉じた）。
const waiting = (f) => f.blocked || f.future || f.held;
// 振り出す担当の種類（無ければ null。src/patrol.js が読む）。1階の結果に従い、待っているもの・対話作業・担当の付いたものは振り出さない。
export const dispatchKind = (f, config) =>
  (f.open && !f.runs.length && !waiting(f) && f.type !== config.dialogType ? (DISPATCH[f.status] ?? null) : null);

export function decide(f, config) {
  // 種類は作るときに決まり、対話作業の境目をまたいで変わらない。境目の向こうへ変わったら、こちら側の最後の種類へ戻す。
  const mine = (t) => (t === config.dialogType) === f.dialog;
  const type = mine(f.type) ? f.type : (f.types.findLast(mine) ?? (f.dialog ? config.dialogType : null));
  // 子が完成で閉じたら、その子が受け持つ条件（「- 子: #N」）は満たされた。
  const byChildren = f.remaining.filter((c) => c.child && f.children.some((k) => k.number === c.child && ACCEPTED(k)));
  const live = { ...f, remaining: f.remaining.filter((c) => !byChildren.includes(c)) };
  const question = f.question && !f.question.answer && stale(live, f.question) ? null : f.question;
  const s = status({ ...live, question }, config);
  if (f.dialog && !DIALOG.includes(s.status)) s.status = "未着手";
  const body = checkLines(f.body, [...byChildren.map((c) => c.index), ...(s.check ?? [])]);
  // 見送りで閉じる・閉じた issue の開いた PR は、もう確かめもマージもしないので閉じる。
  const dropping = (s.closeAs ?? (f.open ? null : f.closedAs)) === "NOT_PLANNED";
  return { type, status: s.status, open: s.status !== "完了", closeAs: s.closeAs, ask: s.ask ?? null, cancel: s.cancel ?? [], closePr: dropping && f.pr ? f.pr.id : null,
    notice: [notice(f, s.status), s.told].filter(Boolean).join("\n\n") || null,
    ready: s.status === "検証待ち" && Boolean(f.pr?.draft), assignees: owner(s.status, config),
    body: s.status === "回答待ち" || (s.status !== "完了" && question && !question.answer) ? withButton(body, config, f.number) : body };
}

// 答えの無い問いを出した事実が、あとの事実で無くなったか（無くなった問いは読まず、表で決め直す）。採否と Claude の判断の問いは、
// ゲートが読める事実から出ていない（ゲートは問いの中身を読まない）ので、答えるまで読む。
function stale(f, q) {
  if (q.kind === "確かめ") return f.remaining.some((c) => c.verify !== "ユーザー"); // 残りが確かめだけでなくなった
  if (q.kind === "イレギュラー") return f.prMoved > q.at; // 手放したあとに、作業ブランチの PR が開かれたかマージされた
  return Boolean(droppedOf(q.text)?.some((n) => !f.dropped.includes(n))); // 見送りだった相手が見送りでなくなった
}

// 2階: 担当者は2択。ユーザーに問わないと進めない（回答待ち・保留）ならユーザー、ほかは Claude（完了は持ち主なし）。
const owner = (status, config) => (status === "完了" ? [] : WAIT.includes(status) ? [config.user] : [config.claude]);

// 受け入れなかった書き込みは、黙らずに1つのコメントで知らせる（形に合わない問い・印の間の見知らぬ行・形の合わない着手可能日時・
// 事実へ戻したユーザーのボードの移動・子に書かれた完了の条件）と、親が閉じたので閉じた子の理由。最新のコメントが同じ知らせなら書かない。
function notice(f, status) {
  const childRule = f.parent && `子は完了の条件を持ちません。条件は親 #${f.parent.number} に置き、行の下に「- 子: #${f.number}」を付けてください。`;
  const text = [f.badQuestion.length && `この問いは形に合わないので、問いとして読みません: ${f.badQuestion.join("・")}`,
    splitBody(f.body).foreign.length && "本文の先頭の印の間に、ゲートの書かない行があったので、消さずに印の外へ出しました。",
    // 直るまで続く知らせは、最近のコメントに同じ知らせがあれば重ねない（値が変われば新しく知らせる）。
    f.badStart && !f.comments.some((c) => c.includes(`「${f.badStart}」`)) &&
      `着手可能日時「${f.badStart}」の形が合わないので受け付けず、その間は振り出しません（\`YYYY-MM-DD HH:MM\` か \`YYYY-MM-DD\`。日本時間）。`,
    f.moved && f.status && status !== f.status && `ステータスを「${f.status}」にしましたが、事実から「${status}」に戻しました（ユーザーが直接決められるのは、保留と、完了（完了の条件が全部済んだときの完成か、見送り）だけです）。`,
    childRule && f.conditions.length && !f.comments.some((c) => c.includes(childRule)) && childRule,
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
    : { status: HELD[f.runs.some((r) => r.kind === "作る") ? "作る" : "確かめる"], cancel: f.runs.slice(1).map((r) => r.id) };
  if (f.status === "保留") return { status: "保留" }; // ユーザーが置いた保留は、ユーザーが出すまで保つ
  // 入口: Claude が起こした要望だけ採否を問い、ほかは未着手。子と分割したものは、採否を親か分割元から受け継ぐ。
  if (!f.status) return f.author === config.claude && f.type === "要望" && !f.parent && !f.origin ? { status: "回答待ち", ask: "採否" } : { status: "未着手" };
  // ユーザーが書いた文（答えの文・コメント）を Claude がまだ読んでいなければ、Claude の番にする（閉じていれば開き直す）。ゲートは文の中身を読まない。
  if (f.unread) return { status: "未着手" };
  // 答えの無い問いがあっても、完了の条件が全部済んだら完成にする（済んだ作業への問いは要らない）。採否は、条件が済んでいても着手するかの答えが要る。
  const q = f.question;
  if (q && !q.answer) {
    const t = table(f);
    return t.status === "完了" && q.kind !== "採否" ? t : { status: "回答待ち" };
  }
  // 答えは、ユーザーの番（回答待ち）に来たときに当てる。書いた文のある答えは、Claude が読んだあとに一度だけ当て、当てたことを知らせる。
  const a = q?.answer;
  if (!a || (f.status !== "回答待ち" && !(a.text && f.answerRead && !f.answerApplied))) return redo(f, table(f));
  const told = a.text ? `${APPLIED}（${a.decision}）。` : null;
  if (a.decision === "見送り") return { status: "完了", closeAs: "NOT_PLANNED", told };
  if (a.decision === "保留") return { status: "保留", told };
  if (q.kind !== "確かめ" || a.decision !== "完了") return { ...redo(f, table(f)), told };
  const ok = f.remaining.filter((c) => c.verify === "ユーザー" && a.confirmed.includes(c.text));
  return { ...table({ ...f, remaining: f.remaining.filter((c) => !ok.includes(c)) }), check: ok.map((c) => c.index), told };
}

// イレギュラーに「やり直す」と答えたら、答えのあとに担当が終わるまで振り出せる形に保つ（CI待ちは見回りが振り出さないので、
// 作る担当へ渡す。答えを当てた1回だけにすると、枠が埋まっていて振り出せないうちに次の決め直しで CI待ちへ戻る）。
const redo = (f, t) => (f.redo && t.status === "CI待ち" ? { ...t, status: "未着手" } : t);

// 手放したあとの表。作業のステータスなのに持たれていないのが、担当が手放した事実。
const IRREGULAR = { status: "回答待ち", ask: "イレギュラー" };
// 検査が1つも無い: CI が始まる形で push・マージするのは、push・マージした担当の責務（担当は検査が出たのを見てから手放す）。
// 手放したときに検査が無ければ、正しく手放せていない。
const noChecks = (released) => (released ? IRREGULAR : { status: "CI待ち" });
// マージのコミットの master の CI が落ちたら、PR の CI が落ちたときと同じく作る担当が打ち直すか直す。直さず手放したらイレギュラー。
const afterMerge = (f, released) => (!f.mergeChecks ? noChecks(released)
  : f.mergeChecks === "FAILURE" ? (released ? IRREGULAR : { status: "未着手" }) : { status: "CI待ち" });
function table(f) {
  const pr = f.pr;
  const released = Object.values(HELD).includes(f.status);
  if (pr) {
    if (pr.backToDraft) return { status: "未着手" }; // 確かめる担当の差し戻し
    if (!pr.checks) return noChecks(released);
    if (pr.checks === "PENDING") return { status: "CI待ち" }; // 下書きかどうかによらず、CI の結果を待つ間は手放す
    if (pr.checks === "FAILURE") return { status: "未着手" };
    // 確かめる担当が、マージも差し戻しも問いもせずに手放した（同じ PR を確かめ直し続けない）。
    return f.status === HELD.確かめる ? IRREGULAR : { status: "検証待ち" };
  }
  // 待つ相手（前提・子）が開いている間は、確かめも完了もしない。見送りで閉じた相手がいれば、続けるかを一度だけ問う。
  if (f.blocked) return { status: "未着手" };
  if (f.dropped.length && !f.droppedAsked) return { status: "回答待ち", ask: { dropped: f.dropped } };
  // 子は完了の条件を持たず、PR がマージされ、マージのコミットの master の CI が通ったら完了。
  if (f.parent && !f.conditions.length) return f.merged ? (f.mergeChecks === "SUCCESS" ? { status: "完了", closeAs: "COMPLETED" } : afterMerge(f, released)) : released ? IRREGULAR : { status: "未着手" };
  // マージのあとの残りは、マージのコミットの master の CI（デプロイを含む）が終わってから扱う（本番に出る前に確かめを問わない。原則2）。
  if (!f.remaining.length) return { status: "完了", closeAs: "COMPLETED" };
  if (f.merged && f.mergeChecks !== "SUCCESS") return afterMerge(f, released);
  if (f.remaining.every((c) => c.verify === "ユーザー")) return { status: "回答待ち", ask: "確かめ" };
  if (f.future) return { status: "未着手" };
  return released && !f.merged ? IRREGULAR : { status: "未着手" };
}
