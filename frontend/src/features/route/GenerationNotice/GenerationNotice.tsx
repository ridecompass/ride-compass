"use client";

import { Callout } from "@/components/ui/Callout/Callout";
import { DialogContent, DialogDescription, DialogRoot } from "@/components/ui/Dialog/Dialog";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import type { GenerationNotice as Notice } from "@/features/route/useRouteGeneration";

interface GenerationNoticeProps {
  /** 出す案内。nullなら窓を閉じる。 */
  notice: Notice | null;
  /** 前の候補が残っているか。残っていれば作り直せなかったことを見出しで言う——候補だけが並ぶと、作り直せたように見える。 */
  hasRoutes: boolean;
  /** ✕・Esc・外側の押下のどれで閉じても呼ばれる。 */
  onClose: () => void;
}

// 押した「生成」が候補を出せなかった理由（入力の誤りか失敗・候補0件の理由）を、パネルの外の窓で知らせる——パネルの中に
// 出すと設定の本文を押し下げ、補足の文では見落とす。候補0件の理由と失敗は色で分ける（空と失敗を混ぜない）。
export default function GenerationNotice({ notice, hasRoutes, onClose }: GenerationNoticeProps) {
  return (
    <DialogRoot
      open={notice !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {notice && (
        <DialogContent title={noticeTitle(notice, hasRoutes)}>
          <DialogDescription asChild>
            <Callout tone={notice.kind === "failed" ? "danger" : "warning"}>
              <GuideText text={notice.message} />
            </Callout>
          </DialogDescription>
        </DialogContent>
      )}
    </DialogRoot>
  );
}

function noticeTitle(notice: Notice, hasRoutes: boolean): string {
  if (notice.kind === "empty") return "候補が見つかりませんでした";
  return hasRoutes ? "作り直せませんでした" : "ルートを作れませんでした";
}
