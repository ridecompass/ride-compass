// この端末で、ログインして今の規約の版に同意済みと確かめたことの覚え。開き直したとき、自分の状態を読み終わるまでの間も
// 最初の画面を出さないために使う（覚えていない端末は、読み込みの間もアプリの説明を出す。Google のブランドの確認の条件）。
//
// サーバーが返す最初の HTML には読み込み中の最初の画面が入るので、画面のスクリプトが動く前に隠す必要がある。`<head>` で
// 最初に動くスクリプト（`CONSENT_MARK_SCRIPT`）が覚えを見て、`<html>` に印を付け、CSS が読み込み中の最初の画面を隠す。

const CONSENT_MARK_KEY = "ridecompass:consented";

/** `<html>` に付ける印（`data-consented`）。読み込み中の最初の画面を隠す CSS が見る。 */
export const CONSENT_MARK_ATTRIBUTE = "data-consented";

/** 最初の HTML の `<head>` で動かすスクリプト。覚えがあれば `<html>` に印を付ける（保存が使えなければ何もしない）。 */
export const CONSENT_MARK_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(CONSENT_MARK_KEY)}))document.documentElement.setAttribute(${JSON.stringify(CONSENT_MARK_ATTRIBUTE)},"")}catch(e){}`;

/** 自分の状態を読み終えたときに、同意済みかを覚える（済んでいなければ覚えと印を消す）。保存が使えなければ何もしない。 */
export function rememberConsent(consented: boolean): void {
  try {
    if (consented) localStorage.setItem(CONSENT_MARK_KEY, "1");
    else {
      localStorage.removeItem(CONSENT_MARK_KEY);
      document.documentElement.removeAttribute(CONSENT_MARK_ATTRIBUTE);
    }
  } catch {
    // 保存が使えない端末は、毎回読み込みの間に最初の画面を出す（ちらつくが、使えなくはならない）。
  }
}
