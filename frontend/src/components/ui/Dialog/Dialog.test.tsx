/**
 * `components/ui/Dialog/Dialog.tsx`——見出しの付いたモーダルの枠と、消す前の確認の窓。
 *
 * 見るもの: 確認の窓が見出しを名前に持つダイアログとして中身を出し、確かめるボタンでだけ確かめた知らせが上がり、
 * キャンセルと✕では取り消しの知らせだけが上がること（見出しの付いた枠は確認の窓を通して見る）。
 *
 * ここで見ないもの: 閉じている間は出さないこと・Escや外側の押下で閉じる・フォーカスを閉じ込める——Radix Dialogの振る舞い。
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./Dialog";

describe("ConfirmDialog", () => {
  function renderConfirm() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="候補をすべて消します" confirmLabel="消す" onConfirm={onConfirm} onCancel={onCancel}>
        消した候補は元に戻せません。
      </ConfirmDialog>,
    );
    return { onConfirm, onCancel, dialog: screen.getByRole("dialog", { name: "候補をすべて消します" }) };
  }

  it("確かめるボタンを押すと、確かめた知らせだけが上がる", async () => {
    const { onConfirm, onCancel, dialog } = renderConfirm();
    expect(dialog).toHaveTextContent("消した候補は元に戻せません。");

    await userEvent.click(within(dialog).getByRole("button", { name: "消す" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each(["キャンセル", "閉じる"])("「%s」を押すと、取り消しの知らせだけが上がる", async (name) => {
    const { onConfirm, onCancel, dialog } = renderConfirm();

    await userEvent.click(within(dialog).getByRole("button", { name }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
