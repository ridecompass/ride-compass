// 説明を見る状態（`components/UsageGuide/UsageGuide.tsx`）を、説明の引き方が分かれる部品を並べた画面の上で描く足場。
// 押されたかを見る受け口（生成・値を動かすキー）と終える操作を返す。`explanation`は出ている説明の面を引く。
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import UsageGuide from "@/components/UsageGuide/UsageGuide";
import { Button } from "@/components/ui/Button/Button";

export function renderScreen() {
  const onEnd = vi.fn();
  const onGenerate = vi.fn();
  const onPartKeyDown = vi.fn();
  const view = render(
    <div>
      <p>本文の文字</p>
      <Button onClick={onGenerate} usage="いまの条件で候補を作ります。">
        生成
      </Button>
      <button type="button" aria-label="地図の色分け" data-usage="色で道の評価を見分けます。">
        色
      </button>
      <span id="label-distance">距離</span>
      <span id="label-unit">km</span>
      <button type="button" aria-labelledby="label-distance label-unit">
        −
      </button>
      <div data-usage="チェックを外した段階を地図から隠します。">
        <label htmlFor="level-1">段階1</label>
        <input id="level-1" type="checkbox" />
      </div>
      <button type="button">
        {"  地図の\n  明るさ  "}
        <span>▼</span>
      </button>
      <button type="button" title="現在地へ移動">
        <svg aria-hidden="true" />
      </button>
      <button type="button" data-testid="no-name">
        <svg aria-hidden="true" />
      </button>
      <button type="button" disabled>
        保存
      </button>
      <div role="slider" aria-label="重み" aria-valuenow={3} tabIndex={0} onKeyDown={onPartKeyDown} />
      <div data-usage="地図の凡例です。">凡例</div>
      <UsageGuide onEnd={onEnd} />
    </div>,
  );
  return { onEnd, onGenerate, onPartKeyDown, view };
}

export function explanation() {
  return screen.queryByRole("dialog", { name: "使い方の説明" });
}
