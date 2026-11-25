import { megaRead, megaWrite } from "./mega.js";

// Internal state files (pomodoro, websites, …) live under lumaris/ as small
// JSON/text blobs. These routes let other workers read/write them through
// the service binding without owning the MEGA client themselves.

export async function StateFunction(env, path, method, body) {
  const relativePath = decodeURIComponent(path);
  if (!relativePath) {
    throw new Error("State path is required");
  }

  if (method === "GET") {
    try {
      const content = await megaRead(env, relativePath, null, true);
      return { success: true, content };
    } catch (e) {
      if (e.message.includes("File not found") || e.message.includes("Folder not found")) {
        return { success: true, content: null };
      }
      throw e;
    }
  }

  if (method === "PUT" || method === "POST") {
    // body is the raw JSON value to store (array, object or string)
    const result = await megaWrite(env, relativePath, body);
    return { success: true, ...result };
  }

  throw new Error("Method not allowed");
}
