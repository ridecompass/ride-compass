// Google のログインのスクリプト（`window.google`。外から読むスクリプトで、テスト環境に無い）の代役。

/** Google のログインの口を置く。描いたボタンを押すと、初めに渡された受け口へ ID トークンを渡す。片付けはテストが`delete window.google`で行う。 */
export function installGoogleSignIn() {
  const seen: { clientId: string | null } = { clientId: null };
  let callback: ((response: { credential: string }) => void) | null = null;
  window.google = {
    accounts: {
      id: {
        initialize(config) {
          seen.clientId = config.client_id;
          callback = config.callback;
        },
        renderButton(parent) {
          const button = document.createElement("button");
          button.textContent = "Google のボタン";
          button.onclick = () => callback?.({ credential: "id-token" });
          parent.append(button);
        },
      },
    },
  };
  return seen;
}
