import type { Metadata } from "next";

import { AppPage } from "@/components/AppPage/AppPage";
import { translate } from "@/i18n/config";

import RideLogWithMap from "./RideLogWithMap";

export const metadata: Metadata = { title: `走行ログ | ${translate("common.appName")}` };

export default function RideLogPage() {
  return (
    <AppPage title="走行ログ">
      <RideLogWithMap />
    </AppPage>
  );
}
