"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { Card } from "@/components/ui/Card/Card";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import InfoPopover from "@/components/ui/InfoPopover/InfoPopover";
import { Input } from "@/components/ui/Input/Input";
import { textVariants } from "@/components/ui/Text/Text";
import {
  getRouteProfiles,
  replaceRouteProfiles,
  type RouteProfile,
  type RouteProfiles,
} from "@/features/admin/adminApi";
import { translate } from "@/i18n/config";
import { errorMessage } from "@/lib/apiError";
import { cn } from "@/lib/cn";
import { getQueryClient } from "@/lib/queryClient";

const ROUTE_PROFILES_QUERY_KEY = ["route-profiles"];

/** ひな形1つが入れ替える設定（負担と道の段）。 */
export type RouteProfileSettings = Pick<RouteProfile, "cost_preference" | "road_avoidance">;

interface RouteProfilesPanelProps {
  /** 足したひな形の設定（標準）。 */
  standard: RouteProfileSettings;
  /** ひな形1つの設定を編集する部品（利用者の画面の「難所」「道路」タブと同じ並びで選ぶ）。 */
  renderSettingsEditor: (
    settings: RouteProfileSettings,
    onChange: (next: RouteProfileSettings) => void,
  ) => React.ReactNode;
}

/** 運営が名前を付けて全員に配る、生成の条件のひな形（負担と道の段）を足し・直し・公開する画面。利用者の画面には公開のものだけが
 * 並ぶ。
 *
 * 全体を手元で直してから「DBへ保存」で1回に送る（並びも保存する。途中の形を配らない）。今の費用の軸・道の段の行に無い名を指す
 * 全体はbackendが断り、その文をここに出す。 */
export default function RouteProfilesPanel({ standard, renderSettingsEditor }: RouteProfilesPanelProps) {
  const t = useTranslations("admin");
  const client = getQueryClient();
  const query = useQuery({ queryKey: ROUTE_PROFILES_QUERY_KEY, queryFn: getRouteProfiles }, client);
  const saved = query.data ?? null;
  // 手元で直している全体。触るまではbackendの全体を映す。
  const [draft, setDraft] = useState<RouteProfile[] | null>(null);
  // 設定を開いているひな形の位置。
  const [opened, setOpened] = useState<number | null>(null);

  const profiles = draft ?? saved?.profiles ?? [];
  const edited = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved?.profiles);

  const save = useMutation(
    {
      mutationFn: (body: RouteProfiles) => replaceRouteProfiles(body),
      onSuccess: (written) => {
        client.setQueryData(ROUTE_PROFILES_QUERY_KEY, written);
        setDraft(null);
      },
    },
    client,
  );
  const error = save.isError ? errorMessage(save.error, t("saveFailed")) : (query.error?.message ?? null);

  const update = (index: number, change: Partial<RouteProfile>) =>
    setDraft(profiles.map((profile, i) => (i === index ? { ...profile, ...change } : profile)));
  const remove = (index: number) => {
    setDraft(profiles.filter((_, i) => i !== index));
    setOpened(null);
  };
  const add = () => {
    setDraft([...profiles, { name: newName(profiles), description: "", published: false, ...standard }]);
    setOpened(profiles.length);
  };

  return (
    <Card className="flex flex-col gap-2" data-state={edited ? "unsaved" : "saved"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1">
          <h2 className={textVariants({ variant: "heading" })}>{t("tabs.routeProfiles")}</h2>
          <InfoPopover triggerAriaLabel={t("infoLabel", { name: t("tabs.routeProfiles") })}>
            <p>{t("routeProfiles.info")}</p>
          </InfoPopover>
        </span>
        {saved && (
          <>
            <Button
              usage={null}
              variant="primary"
              onClick={() => save.mutate({ profiles })}
              disabled={!edited || save.isPending}
            >
              {save.isPending ? t("saving") : t("saveToDb")}
            </Button>
            <Button usage={null} variant="secondary" onClick={add}>
              {t("routeProfiles.add")}
            </Button>
          </>
        )}
        {edited && <span className={textVariants({ variant: "note" })}>{t("routeProfiles.unsaved")}</span>}
        {query.isFetching && <span className={textVariants({ variant: "note" })}>{t("loading")}</span>}
      </div>

      {error && (
        <p className={cn(textVariants({ variant: "error" }), "flex flex-wrap items-center gap-2")}>
          {error}
          {saved === null && (
            <Button usage={null} className="flex-none" size="sm" onClick={() => void query.refetch()}>
              {t("reload")}
            </Button>
          )}
        </p>
      )}

      {saved && profiles.length === 0 && (
        <p className={textVariants({ variant: "hint" })}>{t("routeProfiles.empty")}</p>
      )}

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {profiles.map((profile, index) => (
          <li
            // 名前は直している途中に重なりうるので、位置で見分ける。
            key={index}
            className="flex flex-col gap-1.5 border-b border-[var(--color-border)] pb-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 flex-auto"
                aria-label={t("routeProfiles.name")}
                value={profile.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <label className="flex items-center gap-1 text-[length:var(--font-size-sm)]">
                <Checkbox
                  checked={profile.published}
                  onCheckedChange={(published) => update(index, { published })}
                  aria-label={t("routeProfiles.publish", { name: profile.name })}
                />
                {t("routeProfiles.published")}
              </label>
              <Button
                usage={null}
                size="sm"
                variant="secondary"
                aria-expanded={opened === index}
                onClick={() => setOpened(opened === index ? null : index)}
              >
                {opened === index ? t("routeProfiles.closeSettings") : t("routeProfiles.openSettings")}
              </Button>
              <Button usage={null} size="sm" variant="secondary" onClick={() => remove(index)}>
                {t("routeProfiles.remove")}
              </Button>
            </div>
            <Input
              aria-label={t("routeProfiles.description")}
              placeholder={t("routeProfiles.descriptionPlaceholder")}
              value={profile.description}
              onChange={(event) => update(index, { description: event.target.value })}
            />
            {opened === index &&
              renderSettingsEditor(
                { cost_preference: profile.cost_preference, road_avoidance: profile.road_avoidance },
                (next) => update(index, next),
              )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 足したひな形の名前。名前は重ねられないので、今の名前と重ならないものを選ぶ。 */
function newName(profiles: readonly RouteProfile[]): string {
  const names = new Set(profiles.map(({ name }) => name));
  for (let n = 1; ; n += 1) {
    const name =
      n === 1
        ? translate("admin.routeProfiles.newName")
        : translate("admin.routeProfiles.newNameNumbered", { number: String(n) });
    if (!names.has(name)) return name;
  }
}
