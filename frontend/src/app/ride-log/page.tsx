import type { Metadata } from "next";

import { AppPage } from "@/components/AppPage/AppPage";
import { APP_NAME } from "@/lib/screenNames";

import RideLogWithMap from "./RideLogWithMap";

export const metadata: Metadata = { title: `走行ログ | ${APP_NAME}` };

export default function RideLogPage() {
  return (
    <AppPage title="走行ログ">
      <RideLogWithMap />
    </AppPage>
  );
}
