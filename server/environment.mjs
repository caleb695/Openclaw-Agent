// Infrastructure credentials are not needed by the Gateway or installed plugins.
// This is defense in depth, not isolation from trusted tools running as the same OS user.
export function gatewayEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(TURSO_|MESSENGER_)/.test(key) &&
        !['DASHBOARD_ENCRYPTION_KEY', 'CODESPACES_TOKEN'].includes(key),
    ),
  );
}
