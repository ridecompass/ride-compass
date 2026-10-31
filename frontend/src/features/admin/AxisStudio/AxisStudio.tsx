"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Disclosure, { DisclosureChevron } from "@/components/Disclosure/Disclosure";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs/Tabs";
import { materialCatalogLabel } from "@/lib/axisMaterialsCatalog";
import { listAxisDefinitions } from "@/features/admin/adminApi";
import type { AxisDefinitionResponse, AxisShape } from "@/types/route";
import { AxisCalibration, type CalibrationMapSlot } from "./AxisCalibration";
import { textVariants } from "@/components/ui/Text/Text";
import { cn } from "@/lib/cn";
import { cardVariants } from "@/components/ui/Card/Card";
import { getQueryClient } from "@/lib/queryClient";

// shapeが参照する材料id一覧（`kind`ごとにフィールド名が異なるため統一する）。この中には
// 材料カタログの材料idだけでなく、他axis_idを指すもの（他axis_idを材料として参照する
// 内部軸階層）も混在しうる。
function materialIdsOf(shape: AxisShape): string[] {
  if (shape.kind === "categorical") return [shape.material];
  return shape.terms.map((t) => t.material);
}

// shapeのtermは材料idと他の軸idのどちらも指しうる。軸として見つかればその表示名を、
// 見つからなければ材料カタログから引く。
function labelForMaterialOrAxis(id: string, definitions: readonly AxisDefinitionResponse[]): string {
  return definitions.find((d) => d.axis_id === id)?.label ?? materialCatalogLabel(id);
}

// 軸スタジオのトップレベルコンポーネント。軸の一覧の行を開くと、その行の下にその軸の較正を出す（開くのは1つだけで、
// 閉じた軸の較正は分布・地図を取りに行かない）。軸を足す・材料や表示名を直す・公開を取り消す・消すのは定義ファイル
// （backend/scripts/axis_apply.py）から入れ、この画面は持たない。
export default function AxisStudio({ calibrationMap }: { calibrationMap: CalibrationMapSlot }) {
  const definitionsQuery = useQuery({ queryKey: ["axis-definitions"], queryFn: listAxisDefinitions }, getQueryClient());
  const definitions = definitionsQuery.data ?? null;
  const listError = definitionsQuery.error?.message ?? null;
  const [openAxisId, setOpenAxisId] = useState<string | null>(null);

  async function reload() {
    await definitionsQuery.refetch();
  }

  const draftDefs = definitions?.filter((d) => !d.is_published) ?? [];
  const publishedDefs = definitions?.filter((d) => d.is_published) ?? [];

  function renderRow(def: AxisDefinitionResponse) {
    return (
      <div
        key={def.axis_id}
        className="flex min-w-0 flex-col gap-2 border-b border-[var(--color-border)] pb-2 last:border-b-0 last:pb-0"
      >
        <Disclosure
          open={openAxisId === def.axis_id}
          onOpenChange={(open) => setOpenAxisId(open ? def.axis_id : null)}
          usage="この軸の較正を開きます。"
          triggerClassName="group flex min-w-0 flex-col"
          summary={
            <>
              <span className={cn(textVariants({ variant: "heading" }), "flex items-center gap-1.5")}>
                <DisclosureChevron />
                {def.label}
              </span>
              <span className={cn(textVariants({ variant: "hint" }), "[overflow-wrap:anywhere]")}>
                {def.axis_id} ・ {def.category} ・ 重み{def.default_weight.toFixed(2)} ・{" "}
                {materialIdsOf(def.shape)
                  .map((id) => labelForMaterialOrAxis(id, definitions ?? []))
                  .join("・")}
              </span>
            </>
          }
        >
          <AxisCalibration definition={def} onSaved={reload} calibrationMap={calibrationMap} />
        </Disclosure>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {listError && <p className={textVariants({ variant: "error" })}>{listError}</p>}
      <p className={textVariants({ variant: "hint" })}>
        軸を押すと、点のつけ方と地図の段の境界を、実データの分布と地図を見ながら決める較正を開きます。公開中の軸は公開したまま保存されます。
      </p>

      <Tabs className="flex flex-col gap-2" defaultValue="draft">
        <TabsList>
          <TabsTrigger usage={null} value="draft">
            下書き（{draftDefs.length}）
          </TabsTrigger>
          <TabsTrigger usage={null} value="published">
            公開済み（{publishedDefs.length}）
          </TabsTrigger>
        </TabsList>

        <TabsContent className={cn(cardVariants({ variant: "outline" }), "flex flex-col gap-2")} value="draft">
          {draftDefs.length === 0 && <p className={textVariants({ variant: "hint" })}>下書きの軸はありません。</p>}
          {draftDefs.map(renderRow)}
        </TabsContent>

        <TabsContent className={cn(cardVariants({ variant: "outline" }), "flex flex-col gap-2")} value="published">
          {publishedDefs.length === 0 && (
            <p className={textVariants({ variant: "hint" })}>公開済みの軸はありません。</p>
          )}
          {publishedDefs.map(renderRow)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
