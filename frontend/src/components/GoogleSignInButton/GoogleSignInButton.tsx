"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";
import { textVariants } from "@/components/ui/Text/Text";

// Google Identity Services（GIS）の、ここで使う口だけの型。正本は https://developers.google.com/identity/gsi/web/reference/js-reference
interface GoogleAccountsId {
  initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void;
  renderButton(
    parent: HTMLElement,
    options: { type: "standard"; theme: "outline" | "filled_black"; size: "large"; text: "signin_with"; locale: string },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

// `next/script`を使わず自前で読むのは、既に読んである（`window.google`がある）ときに読み直さず、ボタンを描く所でだけ読むため。
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client?hl=ja";
const DARK = "(prefers-color-scheme: dark)";

function subscribeDark(onChange: () => void): () => void {
  const query = window.matchMedia(DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersDark(): boolean {
  return window.matchMedia(DARK).matches;
}

let loading: Promise<GoogleAccountsId> | null = null;
// `initialize`は1回だけ呼ぶ（2回目からは最後の設定だけが残る）ので、IDトークンは今描いているボタンの受け口へ回す。
let initializedFor: string | null = null;
let receiver: ((credential: string) => void) | null = null;

function loadGoogleAccountsId(): Promise<GoogleAccountsId> {
  if (window.google !== undefined) return Promise.resolve(window.google.accounts.id);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.google!.accounts.id);
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Google のログインを読み込めませんでした"));
    };
    document.head.append(script);
  });
  return loading;
}

interface GoogleSignInButtonProps {
  clientId: string;
  /** Google が渡した ID トークン（JWT）を受ける。 */
  onCredential: (credential: string) => void;
}

/** Google の公式のログインのボタン。端末がダークなら公式の暗いボタンにする。 */
export default function GoogleSignInButton({ clientId, onCredential }: GoogleSignInButtonProps) {
  const parent = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const dark = useSyncExternalStore(subscribeDark, prefersDark, () => false);

  useEffect(() => {
    receiver = onCredential;
    return () => {
      if (receiver === onCredential) receiver = null;
    };
  }, [onCredential]);

  useEffect(() => {
    let alive = true;
    loadGoogleAccountsId().then(
      (id) => {
        if (!alive || parent.current === null) return;
        if (initializedFor !== clientId) {
          id.initialize({ client_id: clientId, callback: ({ credential }) => receiver?.(credential) });
          initializedFor = clientId;
        }
        // 明暗が変わって描き直すときは、前のボタンを除いてから描く。
        parent.current.replaceChildren();
        id.renderButton(parent.current, {
          type: "standard",
          theme: dark ? "filled_black" : "outline",
          size: "large",
          text: "signin_with",
          locale: "ja",
        });
      },
      (error: Error) => alive && setFailure(error.message),
    );
    return () => {
      alive = false;
    };
  }, [clientId, dark]);

  return failure !== null ? (
    <p role="alert" className={cn(textVariants({ variant: "error" }), "m-0")}>
      {failure}
    </p>
  ) : (
    // ボタンは Google の枠（iframe）の中に描かれ、枠の中は明るい色の方式で描かれる。ページのダークと食い違うと、ブラウザが枠に
    // 白い下地を付けるので、枠の色の方式を明るいにそろえる（ダークでは暗いボタンを選ぶ）。
    <div ref={parent} className="min-h-10 [color-scheme:light]" />
  );
}
