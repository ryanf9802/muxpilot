import { parentPort, workerData } from "node:worker_threads";
import { SyncAppDatabase } from "./database.js";

interface DbWorkerRequest {
  id: number;
  method: keyof SyncAppDatabase;
  args: unknown[];
}

const db = new SyncAppDatabase(String(workerData.path));

parentPort?.on("message", (request: DbWorkerRequest) => {
  try {
    const method = db[request.method] as unknown;
    if (typeof method !== "function") throw new Error(`Unknown database method: ${String(request.method)}`);
    const result = Reflect.apply(method, db, request.args);
    parentPort?.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
