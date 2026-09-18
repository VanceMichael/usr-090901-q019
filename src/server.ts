import { startApp } from "./start.js";

const app = await startApp();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ msg: "shutdown", signal }));
  // 给进行中的请求留出完成时间
  const timer = setTimeout(() => process.exit(1), 10_000);
  try {
    await app.close();
    clearTimeout(timer);
    process.exit(0);
  } catch {
    clearTimeout(timer);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
