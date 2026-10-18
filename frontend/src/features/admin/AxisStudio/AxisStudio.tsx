"use client";

import { useQuery } from "@tanstack/react-query";
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

// 軸スタジオのトップレベルコンポーネント。軸の一覧と較正の画面を並べる。軸を足す・材料や表示名を直す・
// 公開を取り消す・消すのは定義ファイル（backend/scripts/axis_apply.py）から入れ、この画面は持たない。
export default function AxisStudio({ calibrationMap }: { calibrationMap: CalibrationMapSlot }) {
  const definitionsQuery = useQuery({ queryKey: ["axis-definitions"], queryFn: listAxisDefinitions }, getQueryClient());
  const definitions = definitionsQuery.data ?? null;
  const listError = definitionsQuery.error?.message ?? null;

  async function reload() {
    await definitionsQuery.refetch();
  }

  const draftDefs = definitions?.filter((d) => !d.is_published) ?? [];
  const publishedDefs = definitions?.filter((d) => d.is_published) ?? [];

  function renderRow(def: AxisDefinitionResponse) {
    return (
      <div
        key={def.axis_id}
        className="flex min-w-0 flex-col border-b border-[var(--color-border)] pb-2 last:border-b-0 last:pb-0"
      >
        <span className={textVariants({ variant: "heading" })}>{def.label}</span>
        <span className={cn(textVariants({ variant: "hint" }), "[overflow-wrap:anywhere]")}>
          {def.axis_id} ・ {def.category} ・ 重み{def.default_weight.toFixed(2)} ・{" "}
          {materialIdsOf(def.shape)
            .map((id) => labelForMaterialOrAxis(id, definitions ?? []))
            .join("・")}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {listError && <p className={textVariants({ variant: "error" })}>{listError}</p>}

      <Tabs className="flex flex-col gap-2" defaultValue="draft">
        <TabsList>
          <TabsTrigger value="draft">下書き（{draftDefs.length}）</TabsTrigger>
          <TabsTrigger value="published">公開済み（{publishedDefs.length}）</TabsTrigger>
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

      <AxisCalibration definitions={definitions ?? []} onSaved={reload} calibrationMap={calibrationMap} />
    </div>
  );
}
