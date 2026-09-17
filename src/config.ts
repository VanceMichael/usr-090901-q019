export interface AppConfig {
  port: number;
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${env.PORT}`);
  }
  return {
    port,
    databaseUrl: env.DATABASE_URL ?? 'postgres://app:local-dev-only@127.0.0.1:5432/app',
  };
}
