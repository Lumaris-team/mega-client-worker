import { FilesFunction, initializeFolderArchitecture } from "./backend/mega/files.js";
import { StateFunction } from "./backend/mega/state.js";
import { StatsFunction } from "./backend/mega/stats.js";
import { getClient } from "./backend/mega/mega.js";

// mega-client-worker — internal MEGA storage API.
//
// This worker is NOT meant to be reached from the public internet: it is
// called by other workers of the same Cloudflare account through a service
// binding (e.g. env.MEGA_CLIENT.fetch(...)). It owns the MEGA session
// (megajs Storage login, connection cache, rate limiting) so callers just
// ask for an operation and get the result back.
//
// CPU constraint: user files are NEVER loaded inside this worker. Downloads
// return a public MEGA URL (mega.nz/file/...) that the client fetches
// directly. Only small internal state files (JSON/text under lumaris/) are
// read/written in memory.
//
// Routes:
//   GET    /ping                     MEGA connection check
//   POST   /init                     ensure the lumaris/files folder tree
//   GET    /list/<path>              list a directory (max 5 items)
//   GET    /read/<path>              public download URL for a file
//   POST   /upload                   { relativePath, content|url } or multipart FormData
//   POST   /folder                   { relativePath }
//   POST   /rename                   { oldPath, newName }
//   DELETE /delete/<path>            delete a file
//   GET    /state/<path>             read a small state file (JSON or text)
//   PUT    /state/<path>             write a small state file (JSON body)
//   POST   /state/<path>             same as PUT
//   GET    /stats?path=files         storage usage of a lumaris/ folder
//
// Credentials: MEGA_EMAIL / MEGA_PASSWORD must be set on this worker
// (plain secret/var or Secrets Store binding — both supported).

const JSON_HEADERS = { "Content-Type": "application/json" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    const method = request.method;

    try {
      // Health / connection check
      if (path === "ping" && method === "GET") {
        await getClient(env);
        return Response.json({ connected: true }, { headers: JSON_HEADERS });
      }

      // Folder tree bootstrap
      if (path === "init" && method === "POST") {
        const result = await initializeFolderArchitecture(env);
        return Response.json(result, { headers: JSON_HEADERS });
      }

      // Storage stats
      if (path === "stats" && method === "GET") {
        const result = await StatsFunction(env, url);
        return Response.json(result, { headers: JSON_HEADERS });
      }

      // Internal state files (small JSON/text blobs)
      if (path.startsWith("state/")) {
        const statePath = path.slice("state/".length);
        let body = null;
        if (method !== "GET" && method !== "HEAD") {
          const raw = await request.text();
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
        const result = await StateFunction(env, statePath, method, body);
        return Response.json(result, { headers: JSON_HEADERS });
      }

      // User files API (same scheme as the legacy /api/files/* routes)
      let body = null;
      if (method !== "GET" && method !== "HEAD") {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          body = await request.formData();
        } else {
          try {
            body = JSON.parse(await request.text());
          } catch {
            body = {};
          }
        }
      }

      const result = await FilesFunction(env, path, method, body);
      return Response.json(result, { headers: JSON_HEADERS });
    } catch (e) {
      console.error("MEGA worker error:", e?.stack || e);
      return Response.json(
        { error: e?.message || "Internal error" },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }
};
