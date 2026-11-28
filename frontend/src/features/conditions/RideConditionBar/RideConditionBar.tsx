"use client";

import { cn } from "@/lib/cn";
import { LENS_LINK_CLASS, LENS_LINK_DESCRIPTION } from "@/lib/lensLink";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover/Popover";
import { useTranslations } from "next-intl";
import { useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import routeGenerateConfig from "@/types/generated/route-generate-config.json";
import { departureLabelParts } from "@/features/conditions/rideConditions";
import { clampSpeedKmh, MAX_SPEED_KMH, MIN_SPEED_KMH } from "@/lib/assumedSpeed";

import DynamicLayerTimeSlider from "@/features/conditions/DynamicLayerTimeSlider/DynamicLayerTimeSlider";
import { nearestTimeIndex, parseJstLocalValue, toJstLocalValue } from "@/lib/time";
import { ClockIcon, SpeedGaugeIcon } from "@/components/ui/icons/lucideIcons";
import { useStoredState } from "@/hooks/useStoredState";
import {
  buildDepartureFrames,
  buildDepartureTimeline,
  DEPARTURE_STEPS,
  isDepartureStep,
  type DepartureStep,
} from "./departureTimeline";
import { Button } from "@/components/ui/Button/Button";
import { NumberInput } from "@/components/ui/NumberInput/NumberInput";
import { Input } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import { GuideText } from "@/components/ui/GuideText/GuideText";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";

/** 想定速度が何の速さか（backendの走行モデルが逆算に使う条件）。 */
const CRUISE_SPEED_LABEL = routeGenerateConfig.cruise_speed_label;

/** 区間ごとの速度の決め方（backendの走行モデルの決まり）。 */
const TRAVEL_MODEL_WORDING = routeGenerateConfig.travel_model_wording;

interface RideConditionBarProps {
  /** 出発時刻（気象レイヤーの表示時刻と同じ共有state）。 */
  departureTime: Date;
  onDepartureTimeChange: (time: Date) => void;
  /** 「今」へ戻す。時刻を選ぶのとは別の操作——選んだ時刻はそこへ留まるが、「今」は
   * 時間の経過に追従する状態へ戻すため、`onDepartureTimeChange(new Date())`では代用
   * できない（現在時刻でピン留めされ、実況の更新から取り残される）。 */
  onDepartureNow: () => void;
  /** 想定速度（km/h）。 */
  speedKmh: number;
  onSpeedKmhChange: (speedKmh: number) => void;
  /** いまの「難所を色で見る」の周りの道の塗りが、出発時刻・想定速度で決まっている。 */
  linkedDeparture: boolean;
  linkedSpeed: boolean;
}

const subscribeNothing = () => () => {};

/** 列のアイコンボタン。アイコンの下へ現在値を出し、読み上げ（aria-label）・ホバー（title）は同じ名前から作る。
 * `PopoverTrigger asChild`が開閉の props と ref をここへ渡すので、受けたものはそのままボタンへ通す。 */
function ConditionTrigger({
  name,
  icon,
  children,
  linked,
  ...buttonProps
}: { name: string; icon: ReactNode; linked: boolean } & ComponentProps<typeof Button>) {
  const t = useTranslations("conditions.bar");
  return (
    <Button
      {...buttonProps}
      variant="mapCtrl"
      size="mapCtrl"
      className={cn("h-auto min-h-[var(--map-ctrl-button-size)] flex-col gap-px py-[3px]", linked && LENS_LINK_CLASS)}
      aria-description={linked ? LENS_LINK_DESCRIPTION : undefined}
      aria-label={t("trigger", { name })}
      title={name}
    >
      {icon}
      <span className="flex flex-col items-center text-[10px] leading-[1.1] font-semibold whitespace-nowrap">
        {children}
      </span>
    </Button>
  );
}

const DEPARTURE_STEP_STORAGE_KEY = "ridecompass:departure-step";

/** 出発時刻のドラッグタイムライン。目盛りは描き始めた（ポップオーバーを開いた）時刻を基準に作る——開いたまま
 * 長時間放置されても「現在」ボタン・目盛りの基準がずれないよう、開くたびに基準を取り直す。刻みは端末に覚える。 */
function DepartureRuler({
  departureTime,
  onDepartureTimeChange,
  onDepartureNow,
}: Pick<RideConditionBarProps, "departureTime" | "onDepartureTimeChange" | "onDepartureNow">) {
  const t = useTranslations("conditions.departure");
  const [anchor] = useState(() => new Date());
  const [step, setStep] = useStoredState<DepartureStep>(DEPARTURE_STEP_STORAGE_KEY, t("stepName"), "hour");
  const { timeline, frames } = useMemo(() => {
    const timeline = buildDepartureTimeline(anchor, step);
    return { timeline, frames: buildDepartureFrames(timeline, step) };
  }, [anchor, step]);
  // 先頭の目盛りは「今」（開いた時刻を刻みへ切り下げた時刻）。「今」に追従する出発時刻も同じく切り下げてある。
  const nowIndex = 0;
  return (
    <DynamicLayerTimeSlider
      frames={frames}
      index={nearestTimeIndex(timeline, departureTime)}
      // 「今」の目盛りを選んだら、その時刻に固定せず「今」への追従へ戻す——固定すると、
      // 放置するうちに過去になり、予報のレイヤーの範囲から外れて表示が消える。
      onIndexChange={(index) => (index === nowIndex ? onDepartureNow() : onDepartureTimeChange(timeline[index]))}
      currentIndex={nowIndex}
      onNow={onDepartureNow}
      ariaLabel={t("name")}
      steps={DEPARTURE_STEPS}
      step={step}
      onStepChange={(next) => {
        if (!isDepartureStep(next)) return;
        setStep(next);
        onDepartureNow();
      }}
    />
  );
}

// 地図右上の走行条件アイコン列。走行条件はルートの評価と気象の表示時刻の両方に効くので、ルート設定フォームではなく
// 地図の上に常時置き、拡大・縮小と方位磁針と同じ列の幅のアイコンボタンに揃える。
export default function RideConditionBar({
  departureTime,
  onDepartureTimeChange,
  onDepartureNow,
  speedKmh,
  onSpeedKmhChange,
  linkedDeparture,
  linkedSpeed,
}: RideConditionBarProps) {
  const t = useTranslations("conditions");
  // 出発時刻の文言は描いた時刻で決まる。ページはビルド時に描かれるので、サーバーとハイドレーションの描画では
  // 出さず、ハイドレーションのあとに出す（出すとビルドの時刻の文言とずれ、ハイドレーションが不一致で失敗する）。
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  const departureLabel = hydrated ? departureLabelParts(departureTime, new Date()) : null;
  const departureName = departureLabel
    ? t("bar.withValue", { name: t("departure.name"), value: departureLabel.join(" ") })
    : t("departure.name");
  const speedLabel = `${speedKmh}km/h`;

  return (
    <div
      className="pointer-events-auto flex flex-col gap-[var(--map-ctrl-stack-gap)]"
      role="group"
      aria-label={t("bar.label")}
    >
      <Popover>
        <PopoverTrigger asChild>
          <ConditionTrigger
            name={departureName}
            icon={<ClockIcon />}
            linked={linkedDeparture}
            usage={t("departure.usage")}
          >
            {/* 別の日は日付も付くため、列の幅に収まるよう日付と時刻を2行に分ける。時刻には「発」を添え、何の時刻かを文字で示す。 */}
            {departureLabel?.map((part, i) => (
              <span key={part} className="block">
                {i === departureLabel.length - 1 ? t("departure.at", { time: part }) : part}
              </span>
            ))}
          </ConditionTrigger>
        </PopoverTrigger>
        <PopoverContent
          tone="bare"
          className="flex max-w-[var(--radix-popover-content-available-width)] flex-col items-end gap-1"
          side="bottom"
          align="end"
        >
          {/* 窓は地図の上に部品だけを浮かせるので、見出しも面に載せる。 */}
          <div className="flex items-center gap-2">
            <h2
              className={cn(
                textVariants({ variant: "heading" }),
                "rounded-sm bg-[var(--color-surface)] px-2 py-1 shadow-float",
              )}
            >
              {t("departure.heading")}
            </h2>
            <Input
              type="datetime-local"
              aria-label={t("departure.input")}
              data-usage={t("departure.inputUsage")}
              value={toJstLocalValue(departureTime)}
              onChange={(e) => {
                const next = parseJstLocalValue(e.target.value);
                if (!Number.isNaN(next.getTime())) onDepartureTimeChange(next);
              }}
              className="h-8 tabular-nums"
            />
          </div>
          <DepartureRuler
            departureTime={departureTime}
            onDepartureTimeChange={onDepartureTimeChange}
            onDepartureNow={onDepartureNow}
          />
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <ConditionTrigger
            name={t("bar.withValue", { name: t("speed.name"), value: speedLabel })}
            icon={<SpeedGaugeIcon />}
            linked={linkedSpeed}
            usage={t("speed.usage", { cruise: CRUISE_SPEED_LABEL })}
          >
            {speedLabel}
          </ConditionTrigger>
        </PopoverTrigger>
        <PopoverContent className="flex flex-col gap-2 px-2 py-1.5" side="bottom" align="end">
          <div className="flex items-center gap-2" data-usage={t("speed.inputUsage", { cruise: CRUISE_SPEED_LABEL })}>
            <input
              type="range"
              aria-label={t("speed.slider")}
              min={MIN_SPEED_KMH}
              max={MAX_SPEED_KMH}
              step={1}
              value={speedKmh}
              onChange={(e) => onSpeedKmhChange(clampSpeedKmh(Number(e.target.value)))}
              className="h-6 min-w-32 flex-1"
            />
            <NumberInput
              commitOn="commit"
              aria-label={t("speed.input")}
              inputMode="numeric"
              min={MIN_SPEED_KMH}
              max={MAX_SPEED_KMH}
              step={1}
              value={speedKmh}
              onValueChange={(next) => onSpeedKmhChange(clampSpeedKmh(next))}
              className="h-8 w-18 tabular-nums"
            />
            <span className={textVariants({ variant: "hint" })}>km/h</span>
          </div>
          <div className="flex items-center gap-1">
            <p className={textVariants({ variant: "hint" })}>{CRUISE_SPEED_LABEL}</p>
            <InfoPopover triggerAriaLabel={t("speed.info")}>
              <p>
                <GuideText text={t("speed.notAverage", { cruise: CRUISE_SPEED_LABEL })} />
              </p>
              <p>
                <GuideText text={TRAVEL_MODEL_WORDING} />
              </p>
            </InfoPopover>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
