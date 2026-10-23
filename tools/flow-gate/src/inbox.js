// 届いた出来事の受け箱。受け取ったと返す前に書くので、処理が落ちても出来事を失わない。1件1キーなので、入れるのと処理するのが重なっても
// 互いを消さない。一時の失敗は間をあけてやり直し（後ろの出来事は先に進む。失敗が打ち直してよい時刻 retryAt を持てば、それより前には打たない）、直らない失敗と retries 回落ちたものは諦める（Claude の番の issue は
// 定時の決め直しで戻る。src/flow.js: handle）。
// 次に起こす時刻（置かないなら null）。置かれたアラームが無いか、それより早いときだけ置く（処理の間に入った出来事が置いた早いアラームを、
// 遅いやり直しの時刻で上書きしない）。
export const nextAlarm = (next, set) => (next !== null && (set === null || next < set) ? next : null);

export class Inbox {
  constructor(storage, process) { Object.assign(this, { storage, process }); }
  push(name, payload) { return this.storage.put(`q:${Date.now()}:${crypto.randomUUID()}`, { name, payload, tries: 0 }); }

  // やり直しを待つ出来事が残れば、次に起こす時刻を返す。limit 件を処理したら、まだあっても今の時刻を返して次の起こしに回す
  // （Worker の1回の起こしで外へ出せる要求の数には上限がある）。
  async drain(retries, now = Date.now(), limit = Infinity) {
    for (let done = 0; ; ) {
      const queue = [...(await this.storage.list({ prefix: "q:" }))];
      const ready = queue.filter(([, e]) => !(e.after > now));
      if (!ready.length) {
        const waits = queue.map(([, e]) => e.after).filter((t) => t > now);
        return waits.length ? Math.min(...waits) : null;
      }
      for (const [key, e] of ready) {
        if (done++ >= limit) return now;
        try {
          await this.process(e.name, e.payload);
        } catch (error) {
          if (error.transient && e.tries + 1 < retries) {
            await this.storage.put(key, { ...e, tries: e.tries + 1, after: Math.max(now + 2 ** e.tries * 60e3, error.retryAt ?? 0) });
            continue;
          }
          // 諦める出来事は、黙って捨てずに Worker の記録へ残す（何がなぜ落ちたかを、あとから読めるように）。
          console.error(`出来事 ${e.name} を諦めた（${e.tries + 1} 回目）: ${error.stack ?? error.message}`);
        }
        await this.storage.delete(key);
      }
    }
  }

  // まだ処理していない、その名前の出来事の中身。
  async pending(name) { return [...(await this.storage.list({ prefix: "q:" })).values()].filter((e) => e.name === name).map((e) => e.payload); }
}
