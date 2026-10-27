"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/ui/Badge/Badge";
import { Button } from "@/components/ui/Button/Button";
import { DialogContent, DialogRoot } from "@/components/ui/Dialog/Dialog";
import { SavedPlaceIcon, SavePlaceIcon, SearchPlaceIcon } from "@/components/ui/icons/lucideIcons";
import { Input } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { isRepresentative } from "@/features/route/PlaceSearch/PlaceCandidates";
import { areaAt } from "@/features/route/placeSearchApi";
import { savedPlaceAt } from "@/features/route/savedPlaces";
import type { SavedPlacesState } from "@/features/route/useSavedPlaces";
import { cn } from "@/lib/cn";
import { getQueryClient } from "@/lib/queryClient";
import type { Coordinates, PinRole, PlaceCandidate } from "@/types/route";

import PointMark from "@/components/PinMark/PointMark";

interface PointDetailProps {
  role: PinRole;
  /** 地点の呼び名（出発地／経由地2／目的地／経由地を足す）。 */
  title: string;
  /** 印に入れる字（経由地の番号。地図のピンと同じ）。 */
  markLabel?: string;
  /** どうやって置いた地点か（探して選んだ地点／地図で選んだ地点）。置いていない・現在地なら無し（名前が現在地と言う）。 */
  source?: string;
  /** 地点の名前（探した施設・住所の名前／地図で選んだ地点／現在地／未設定）。経由地を足すときは無し。 */
  name?: string;
  /** 探して置いた地点なら、その候補（辺りと、代表の位置かを出す）。 */
  found: PlaceCandidate | null;
  /** 地点の位置。置いていない・現在地を取れていなければnull。辺りの無い地点は、ここから辺りを引いて出す。 */
  at: Coordinates | null;
  /** 地点が置いてあるか。探すボタンの文言を「置き直す」にする。 */
  placed: boolean;
  /** 探すボタンの右に並べる操作（消す・現在地に戻す。どれもアイコンだけの形）。要らない間も出し入れせず、押せない形で
   * 渡す（押した直後に並びが動くと、続けて押したときに別の操作に当たる）。 */
  extra?: React.ReactNode;
  /** 地図をタップするとこの地点を置く間に、探すボタンに添える文言。置いた数を隠さないため、経由地を足す間は件数を添える。 */
  placingHint?: string;
  /** 上限まで置いてあり、これ以上置けない（地図でも探してもの両方）。 */
  full?: boolean;
  /** 地図をタップするとこの地点を置くか（ルート設定が地図で効いている間）。 */
  placing: boolean;
  /** 出発地の印を、実際の位置（現在地か置いた地点）の色で出すか。 */
  originLocated: boolean;
  /** 地図の上端の地点の検索の欄を、この地点の役割で開く。 */
  onSearchOpen: () => void;
  /** 保存した地点の一覧と保存・削除。置いた地点を保存する。 */
  savedPlaces: SavedPlacesState;
}

/**
 * 押した地点の詳しく: どの地点か・どうやって置いたか・名前・辺り（探した施設は候補の辺り、地図で選んだ地点・現在地・辺りの
 * 無い施設は位置から引いた辺り。探した住所は名前が住所なので出さない）と、地図の上端の検索の欄をこの地点の役割で開くボタンと、
 * 消す・現在地に戻す・置いた地点の保存（保存した地点なら保存をやめる）。
 */
export default function PointDetail({
  role,
  title,
  markLabel,
  source,
  name,
  found,
  at,
  placed,
  extra,
  placingHint = "地図をタップ",
  full = false,
  placing,
  originLocated,
  onSearchOpen,
  savedPlaces,
}: PointDetailProps) {
  // 探した住所は名前が辺りを含み、代表の位置なら行きたい所そのものでもないので、辺りは引かない。
  const representative = found !== null && isRepresentative(found);
  const areaPoint = found?.kind !== "address" && found?.area == null ? at : null;
  const placedArea = useQuery(
    {
      queryKey: ["place-area", areaPoint?.latitude, areaPoint?.longitude],
      queryFn: () => areaAt(areaPoint!),
      enabled: areaPoint !== null,
    },
    getQueryClient(),
  );
  // 引けない間・引けなかったときは辺りを出さない（名前と出どころは出ている）。
  const area = found?.area ?? (areaPoint !== null ? (placedArea.data ?? null) : null);

  // 置いた地点の保存。名前の欄には、探して置いた候補の名前か辺り（地図で選んだ地点・現在地は辺りのほうが見分けやすい）を入れておく。
  const savedHere = at !== null ? savedPlaceAt(savedPlaces.places, at) : null;
  const suggestedPlaceName = found?.name ?? area ?? name ?? title;
  const [naming, setNaming] = useState(false);
  // 手で書き換えるまでは、上の仮の名前を出す（空にして保存しても仮の名前）。
  const [placeNameDraft, setPlaceNameDraft] = useState<string | null>(null);
  const placeName = placeNameDraft?.trim() || suggestedPlaceName;
  const overwritingPlace = savedPlaces.places.some((place) => place.name === placeName);

  function savePlace() {
    if (at === null) return;
    // 地図で選んだ地点・現在地は、その位置そのもの（施設と同じく代表の位置ではない）として持つ。
    const { kind, level } = found ?? { kind: "facility" as const, level: "point" as const };
    savedPlaces.save({ kind, level, name: placeName, area, latitude: at.latitude, longitude: at.longitude });
    setNaming(false);
  }

  return (
    <section
      aria-label={title}
      className="group flex flex-col gap-1 rounded-sm border border-[var(--color-border)] p-1.5 data-[placing=true]:border-[var(--color-accent)] data-[placing=true]:shadow-[inset_0_0_0_1px_var(--color-accent)]"
      data-placing={placing}
    >
      <div className="flex min-w-0 items-start gap-2">
        <PointMark role={role} label={markLabel} originLocated={originLocated} className="mt-0.5" />
        <div className="min-w-0 flex-auto">
          {/* 呼び名・名前・出どころを1行に並べ、入らなければ折り返す。出どころが名前と同じ（地図で選んだ地点）なら重ねて出さない。 */}
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span
              className={cn(
                textVariants({ variant: "note" }),
                "group-data-[placing=true]:text-[var(--color-accent-strong)]",
              )}
            >
              {title}
            </span>
            {name !== undefined && (
              <span className={cn(textVariants({ variant: "body" }), "font-bold [overflow-wrap:anywhere]")}>
                {name}
              </span>
            )}
            {source !== undefined && source !== name && (
              <span className={textVariants({ variant: "note" })}>{source}</span>
            )}
          </p>
          {(area !== null || representative) && (
            <p className="flex min-w-0 flex-wrap items-center gap-1">
              {area !== null && (
                <span className={cn(textVariants({ variant: "note" }), "[overflow-wrap:anywhere]")}>{area}</span>
              )}
              {/* 当たった範囲の中ほどの位置で、行きたい所そのものではない（ピンを直すのは地図の上）。 */}
              {representative && <Badge variant="warning">代表の位置</Badge>}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          className="min-w-0 flex-auto justify-start gap-1.5"
          aria-label={`${title}を探す`}
          disabled={full}
          onClick={onSearchOpen}
          usage={`地図の上端の欄で、住所・施設の名前を打って${title}を探します。`}
        >
          <SearchPlaceIcon size={14} />
          {/* 狭い幅では省かずに折り返す（「地図をタップか、住所・施設で探す」は幅 390 で1行に収まらない）。 */}
          <span className="min-w-0 whitespace-normal text-left leading-tight">
            {placing ? `${placingHint}か、住所・施設で探す` : placed ? "住所・施設で置き直す" : "住所・施設で探す"}
          </span>
        </Button>
        {extra}
        {savedHere !== null ? (
          <Button
            size="panelIcon"
            className="flex-none"
            aria-label={`「${savedHere.name}」の保存をやめる`}
            onClick={() => savedPlaces.remove(savedHere)}
            usage="保存した地点から外します。置いた地点はそのまま残ります。"
          >
            <SavedPlaceIcon />
          </Button>
        ) : (
          <Button
            size="panelIcon"
            className="flex-none"
            aria-label="地点を保存"
            disabled={at === null}
            aria-haspopup="dialog"
            aria-expanded={naming}
            onClick={() => {
              setPlaceNameDraft(null);
              setNaming(true);
            }}
            usage="この地点に名前を付けてこの端末に保存します。保存した地点は、地点の検索の欄を押すと候補に出ます。"
          >
            <SavePlaceIcon />
          </Button>
        )}
      </div>
      <DialogRoot open={naming} onOpenChange={setNaming}>
        <DialogContent title="地点を保存">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              savePlace();
            }}
          >
            <Input
              aria-label="保存する地点の名前"
              className="min-w-0 flex-auto"
              value={placeNameDraft ?? suggestedPlaceName}
              onChange={(event) => setPlaceNameDraft(event.target.value)}
            />
            <Button type="submit" size="sm" className="flex-none">
              {overwritingPlace ? "上書き保存" : "保存"}
            </Button>
          </form>
        </DialogContent>
      </DialogRoot>
    </section>
  );
}
