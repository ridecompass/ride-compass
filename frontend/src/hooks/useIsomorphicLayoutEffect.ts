"use client";

import { useEffect, useLayoutEffect } from "react";

// ブラウザでは描画の前に走らせ、初回の描画から正しい見た目にする（サーバーではuseEffect）。
export const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
