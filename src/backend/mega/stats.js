import { getClient, getFolderIfExists } from "./mega.js";

const FILES_ROOT = "files";

async function getFolderSize(storage, folderPath) {
  const folder = await getFolderIfExists(storage, folderPath);
  if (!folder) return 0;

  let totalSize = 0;

  async function calculateSize(node) {
    if (node.directory) {
      const children = await node.children;
      for (const child of children) {
        await calculateSize(child);
      }
    } else {
      totalSize += node.size || 0;
    }
  }

  await calculateSize(folder);
  return totalSize;
}

// Storage usage stats — ?path= selects the folder under lumaris/
// (default: files/). Returns bytes per top-level item plus a total.
// The percentage is computed against the REAL account quota
// (getAccountInfo → mstrg), not a hardcoded capacity.
export async function StatsFunction(env, url) {
  const requested = url.searchParams.get("path") || FILES_ROOT;

  try {
    const storage = await getClient(env);

    // Real account quota — MEGA returns it on every login, no extra cost.
    let capacityGB = 20;
    let accountBytes = 0;
    try {
      const info = await storage.getAccountInfo();
      if (info?.spaceTotal > 0) capacityGB = info.spaceTotal / 1024 / 1024 / 1024;
      accountBytes = info?.spaceUsed || 0;
    } catch (e) {
      console.warn("getAccountInfo failed, falling back to 20GB:", e?.message);
    }

    const bytes = await getFolderSize(storage, requested);

    return {
      totalBytes: accountBytes || bytes,
      folderBytes: bytes,
      capacityGB,
      items: [
        { key: `${requested}/`, label: `lumaris/${requested}/`, bytes },
      ]
    };
  } catch (error) {
    console.error(`Error calculating size for ${requested}:`, error);
    return {
      totalBytes: 0,
      capacityGB: 20,
      items: [
        { key: `${requested}/`, label: `lumaris/${requested}/`, bytes: 0 },
      ]
    };
  }
}
