/**
 * 端末に保存して、開き直しても戻る状態（`hooks/useStoredState.ts`）——保存値を読んで復元し、変えるたびに保存する。
 * 読めない保存値は、どの保存値かを添えた`StoredValueError`を投げる。
 *
 * 保存はテスト環境の `localStorage` を本物のまま使う。
 */
import { act, render, renderHook } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoredValueError } from "@/lib/safeStorage";

import { useStoredState } from "./useStoredState";

const KEY = "stored-state-test";

afterEach(() => {
  window.localStorage.clear();
});

/** 投げられた例外を受け取る、エラーの境目。 */
class Boundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Size() {
  const [size] = useStoredState(KEY, "大きさ", 1);
  return <p>{size}</p>;
}

describe("useStoredState", () => {
  it("今の値から作る関数を渡して変えると保存し、開き直すと同じ値へ戻る", () => {
    const first = renderHook(() => useStoredState(KEY, "大きさ", 1));
    act(() => first.result.current[1]((prev) => prev + 2));
    first.unmount();

    const second = renderHook(() => useStoredState(KEY, "大きさ", 1));

    expect(second.result.current[0]).toBe(3);
  });

  it("読めない保存値は、保存値の名前を添えて投げる", () => {
    window.localStorage.setItem(KEY, "{");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();

    render(
      <Boundary onError={onError}>
        <Size />
      </Boundary>,
    );
    const error = onError.mock.calls[0][0] as StoredValueError;
    expect(error).toBeInstanceOf(StoredValueError);
    expect(error.message).toContain("端末に保存した大きさを読めませんでした");
  });
});
