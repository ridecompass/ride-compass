interface AdminBasicAuthCredentials {
  username: string;
  password: string;
}

/** 管理画面のBasic認証の資格情報。片方でも空なら`null`（空のパスワードで認証を通さない）。 */
export function adminBasicAuthCredentials(): AdminBasicAuthCredentials | null {
  const username = process.env.ADMIN_BASIC_AUTH_USERNAME;
  const password = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}
