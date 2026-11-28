import { getClient, getFolderIfExists, getOrCreateFolder, megaGetLink, megaWrite, megaDelete, normalizePath } from "./mega.js";

const FILES_ROOT = "files";
const MAX_ITEMS = 5;

// Initialize the folder architecture on first load
export async function initializeFolderArchitecture(env) {
  try {
    const storage = await getClient(env);
    console.log('Initializing folder architecture...');

    // Create the root "files" folder if it doesn't exist
    await getOrCreateFolder(storage, FILES_ROOT);

    console.log('Folder architecture initialized successfully');
    return { success: true };
  } catch (error) {
    console.error('Error initializing folder architecture:', error);
    throw error;
  }
}

function getFileExtension(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function listDirectory(env, relativePath = "") {
  const storage = await getClient(env);
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);

  try {
    const folder = await getFolderIfExists(storage, fullPath);
    if (!folder) {
      return { files: [], folders: [], path: relativePath };
    }

    const children = await folder.filter(() => true);

    const files = [];
    const folders = [];
    let count = 0;

    for (const child of children) {
      if (count >= MAX_ITEMS) break;

      const item = {
        name: child.name,
        path: relativePath ? `${relativePath}/${child.name}` : child.name,
        size: child.size || 0,
        modified: child.timestamp ? formatDate(child.timestamp) : "",
        extension: child.directory ? "" : getFileExtension(child.name)
      };

      if (child.directory) {
        folders.push(item);
      } else {
        files.push(item);
      }
      count++;
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    return { files, folders, path: relativePath, truncated: count >= MAX_ITEMS };
  } catch (e) {
    return { files: [], folders: [], path: relativePath };
  }
}

// Returns a PUBLIC MEGA download URL — the file content is never loaded
// inside this worker (CPU limits). The client downloads directly from MEGA.
async function readFile(env, relativePath) {
  try {
    const fileInfo = await megaGetLink(env, `${FILES_ROOT}/${relativePath}`);
    return { success: true, url: fileInfo.url, name: fileInfo.name, size: fileInfo.size };
  } catch (e) {
    return { success: false, error: "File not found" };
  }
}

// Helper: dynamic chunk sizing shared by URL and buffer uploads
function uploadChunkConfig(fileSizeMB) {
  let initialChunkSize = 1048576; // 1MB default
  let chunkSizeIncrement = 1048576; // 1MB increment
  let maxChunkSize = 8388608; // 8MB max
  let maxConnections = 2;

  if (fileSizeMB > 100) {
    initialChunkSize = 2097152; // 2MB
    chunkSizeIncrement = 2097152; // 2MB
    maxChunkSize = 16777216; // 16MB
    maxConnections = 3;
  } else if (fileSizeMB > 50) {
    initialChunkSize = 1048576; // 1MB
    chunkSizeIncrement = 1048576; // 1MB
    maxChunkSize = 8388608; // 8MB
    maxConnections = 2;
  }

  return { initialChunkSize, chunkSizeIncrement, maxChunkSize, maxConnections };
}

function makeUploadStream(folder, fileName, size, fileSizeMB) {
  const { initialChunkSize, chunkSizeIncrement, maxChunkSize, maxConnections } = uploadChunkConfig(fileSizeMB);
  const timeoutMs = Math.max(300000, fileSizeMB * 10000); // 10s per MB, min 5min

  const uploadStream = folder.upload({
    name: fileName,
    size,
    maxConnections,
    initialChunkSize,
    chunkSizeIncrement,
    maxChunkSize,
    handleRetries: (tries, error, cb) => {
      console.log(`MEGA upload retry ${tries}/12, error:`, error.message);
      if (tries > 12) {
        cb(error);
      } else {
        const delay = 2000 * Math.pow(2, tries);
        setTimeout(cb, delay);
      }
    }
  });

  return { uploadStream, initialChunkSize, timeoutMs };
}

async function waitUploadComplete(uploadStream, timeoutMs) {
  return await Promise.race([
    uploadStream.complete,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Upload timeout after ${timeoutMs / 1000 / 60} minutes`)), timeoutMs)
    )
  ]);
}

// Stream a remote URL into MEGA (used for "import from URL" uploads)
async function uploadFromURL(env, relativePath, url, storage = null) {
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);
  const storageInstance = storage || await getClient(env);

  console.log(`uploadFromURL called: path=${fullPath}, url=${url}`);

  const segments = fullPath.split("/").filter(Boolean);
  if (segments.length > 1) {
    const folderPath = segments.slice(0, -1).join("/");
    await getOrCreateFolder(storageInstance, folderPath);
  }

  const fileName = segments.at(-1);
  const folderPath = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  const folder = folderPath ? await getOrCreateFolder(storageInstance, folderPath) : storageInstance.root;

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download from URL: ${response.status}`);
  }

  let fileSize = parseInt(response.headers.get('content-length')) || 0;

  // Chunked responses carry no content-length — MEGA needs the exact size
  // upfront, so buffer the body instead (bounded to stay within Worker memory).
  if (!fileSize) {
    const MAX_BUFFERED = 64 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    const reader0 = response.body.getReader();
    while (true) {
      const { done, value } = await reader0.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BUFFERED) throw new Error("Remote file too large to import without a known size");
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return await uploadFromBuffer(env, relativePath, Buffer.from(merged), storage);
  }

  const fileSizeMB = fileSize / 1024 / 1024;

  const { uploadStream, initialChunkSize, timeoutMs } = makeUploadStream(folder, fileName, fileSize, fileSizeMB);

  const reader = response.body.getReader();
  let totalBytesRead = 0;
  let lastProgressLog = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        uploadStream.end();
        break;
      }

      const canContinueWriting = uploadStream.write(Buffer.from(value));

      if (!canContinueWriting) {
        await new Promise(resolve => {
          uploadStream.once('drain', resolve);
        });
      }

      totalBytesRead += value.length;

      if (fileSizeMB > 10 && Date.now() - lastProgressLog > 10000) {
        const progress = fileSize > 0 ? ((totalBytesRead / fileSize) * 100).toFixed(1) : 'unknown';
        console.log(`Download/upload progress: ${progress}% (${(totalBytesRead / 1024 / 1024).toFixed(2)} MB / ${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
        lastProgressLog = Date.now();
      }
    }

    const file = await waitUploadComplete(uploadStream, timeoutMs);

    console.log(`Successfully uploaded file from URL: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      name: file.name,
      size: file.size,
      nodeId: file.nodeId,
      downloadId: file.downloadId
    };
  } catch (error) {
    console.error(`MEGA streaming upload error:`, error);
    throw error;
  }
}

// Upload a buffer already in memory (FormData / small content)
async function uploadFromBuffer(env, relativePath, fileData, storage = null) {
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);
  const storageInstance = storage || await getClient(env);

  console.log(`uploadFromBuffer called: path=${fullPath}, size=${fileData.length} bytes (${(fileData.length / 1024 / 1024).toFixed(2)} MB)`);

  const segments = fullPath.split("/").filter(Boolean);
  if (segments.length > 1) {
    const folderPath = segments.slice(0, -1).join("/");
    await getOrCreateFolder(storageInstance, folderPath);
  }

  const fileName = segments.at(-1);
  const folderPath = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  const folder = folderPath ? await getOrCreateFolder(storageInstance, folderPath) : storageInstance.root;

  const fileSizeMB = fileData.length / 1024 / 1024;
  const { uploadStream, initialChunkSize, timeoutMs } = makeUploadStream(folder, fileName, fileData.length, fileSizeMB);

  const chunkSize = initialChunkSize;
  let offset = 0;

  try {
    while (offset < fileData.length) {
      const chunk = fileData.slice(offset, offset + chunkSize);
      const canContinueWriting = uploadStream.write(chunk);

      if (!canContinueWriting) {
        await new Promise(resolve => {
          uploadStream.once('drain', resolve);
        });
      }

      offset += chunkSize;
    }

    uploadStream.end();

    const file = await waitUploadComplete(uploadStream, timeoutMs);

    console.log(`Successfully uploaded file from buffer: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      name: file.name,
      size: file.size,
      nodeId: file.nodeId,
      downloadId: file.downloadId
    };
  } catch (error) {
    console.error(`MEGA buffer upload error:`, error);
    throw error;
  }
}

async function writeFile(env, relativePath, content = null, url = null, fileData = null) {
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);
  const storage = await getClient(env);

  // If file data is provided (FormData upload), stream to MEGA
  if (fileData) {
    return await uploadFromBuffer(env, relativePath, fileData, storage);
  }

  // If URL is provided, use streaming upload from URL
  if (url) {
    return await uploadFromURL(env, relativePath, url, storage);
  }

  // Otherwise, use traditional content upload
  console.log(`writeFile called: path=${fullPath}, content length=${typeof content === 'string' ? content.length : 'unknown'}`);

  // Decode base64 content if it's a data URL
  let actualContent = content;
  if (typeof content === 'string' && content.startsWith('data:')) {
    const base64Data = content.split(',')[1];
    actualContent = Buffer.from(base64Data, 'base64').toString('utf8');
  }

  const result = await megaWrite(env, fullPath, actualContent, storage);
  return { success: true, url: result.url, name: result.name, size: result.size };
}

async function deleteFile(env, relativePath) {
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);

  try {
    await megaDelete(env, fullPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: "File not found" };
  }
}

async function renameItem(env, oldPath, newName) {
  const fullPath = normalizePath(`${FILES_ROOT}/${oldPath}`);
  const storage = await getClient(env);

  console.log(`renameItem called: oldPath=${fullPath}, newName=${newName}`);

  const segments = fullPath.split("/").filter(Boolean);
  const oldName = segments.at(-1);
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join("/") : "";

  // Get parent folder
  const parent = parentPath ? await getFolderIfExists(storage, parentPath) : storage.root;

  if (!parent) {
    throw new Error("Parent folder not found");
  }

  // Find the item to rename
  const children = await parent.children;
  const item = children.find(child => child.name === oldName);

  if (!item) {
    throw new Error("Item not found");
  }

  // Rename the item
  await item.rename(newName);

  console.log(`Successfully renamed item from ${oldName} to ${newName}`);
  return { success: true };
}

async function createFolder(env, relativePath) {
  const storage = await getClient(env);
  const fullPath = normalizePath(`${FILES_ROOT}/${relativePath}`);

  await getOrCreateFolder(storage, fullPath);
  return { success: true };
}

export async function FilesFunction(env, path, method, body) {
  switch (method) {
    case "GET":
      if (path === "" || path === "/") {
        // List root directory
        return await listDirectory(env, "");
      }
      if (path.startsWith("list/")) {
        const relativePath = decodeURIComponent(path.slice("list/".length));
        return await listDirectory(env, relativePath);
      }
      if (path.startsWith("read/")) {
        const relativePath = decodeURIComponent(path.slice("read/".length));
        return await readFile(env, relativePath);
      }
      throw new Error("Invalid GET path");

    case "POST":
      if (path === "upload") {
        // Check if body is FormData (multipart)
        if (body instanceof FormData) {
          const file = body.get('file');
          const relativePath = body.get('relativePath');

          if (!relativePath) {
            throw new Error("relativePath is required");
          }
          if (!file) {
            throw new Error("file is required");
          }

          // Convert file to ArrayBuffer then Buffer
          const arrayBuffer = await file.arrayBuffer();
          const fileData = Buffer.from(arrayBuffer);

          return await writeFile(env, relativePath, null, null, fileData);
        } else {
          // Legacy JSON upload
          const { relativePath, content, url } = body;
          if (!relativePath) {
            throw new Error("relativePath is required");
          }
          if (!content && !url) {
            throw new Error("content or url is required");
          }
          return await writeFile(env, relativePath, content, url);
        }
      }
      if (path === "folder") {
        const { relativePath } = body;
        if (!relativePath) {
          throw new Error("relativePath is required");
        }
        return await createFolder(env, relativePath);
      }
      if (path === "rename") {
        const { oldPath, newName } = body;
        if (!oldPath || !newName) {
          throw new Error("oldPath and newName are required");
        }
        return await renameItem(env, oldPath, newName);
      }
      throw new Error("Invalid POST path");

    case "DELETE":
      if (path.startsWith("delete/")) {
        const relativePath = decodeURIComponent(path.slice("delete/".length));
        return await deleteFile(env, relativePath);
      }
      throw new Error("Invalid DELETE path");

    default:
      throw new Error("Method not allowed");
  }
}
