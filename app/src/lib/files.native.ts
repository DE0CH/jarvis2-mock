// First-prompt attachments in the app: photos from the library (or a document from Files), shrunk
// on the device, then uploaded to staging (api/uploads) with progress — the same request the web
// page makes (files.ts). The picked file stays a local URI; nothing is read into JS memory.
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File, UploadTask, UploadType } from "expo-file-system";
import { url, httpError, networkError } from "./api";
import { authHeaders } from "./auth";

export type Picked = { name: string; size: number; type: string; file?: never; uri?: string; width?: number; height?: number };
export type Uploaded = { name: string; size: number; isImage: boolean };

export const isPicture = (f: { name: string; type: string }) => /^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
export const IMG_MAX_EDGE = 2048, IMG_KEEP_BYTES = 1.5 * 1024 * 1024;
export const fromFiles = (_: unknown): Picked[] => [];

export async function pickPhotos(): Promise<Picked[]> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 1, selectionLimit: 20 });
  if (r.canceled) return [];
  return r.assets.map((a, i) => ({
    uri: a.uri, name: a.fileName || `photo-${i + 1}.${(a.mimeType || "image/jpeg").split("/")[1]}`, size: a.fileSize || 0,
    type: a.mimeType || (a.type === "video" ? "video/mp4" : "image/jpeg"), width: a.width, height: a.height,
  }));
}
export async function pickDocuments(): Promise<Picked[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return r.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size || 0, type: a.mimeType || "application/octet-stream" }));
}
export const pickFiles = pickPhotos;

export async function shrink(p: Picked): Promise<Picked> {
  if (!isPicture(p) || !p.uri) return p;
  const heic = /heic|heif/i.test(p.type) || /\.(heic|heif)$/i.test(p.name);
  const big = Math.max(p.width || 0, p.height || 0);
  if (!heic && p.size <= IMG_KEEP_BYTES && big <= IMG_MAX_EDGE) return p;
  try {
    const ctx = ImageManipulator.manipulate(p.uri);
    if (big > IMG_MAX_EDGE) ctx.resize(p.width! >= p.height! ? { width: IMG_MAX_EDGE } : { height: IMG_MAX_EDGE });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const size = new File(out.uri).size || 0;
    if (!heic && size >= p.size) return p;
    return { uri: out.uri, name: p.name.replace(/\.[^.]*$/, "") + ".jpg", size, type: "image/jpeg", width: out.width, height: out.height };
  } catch { return p; } // undecodable here: send it as is
}

export async function upload(uploadId: string, p: Picked, name: string, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<Uploaded> {
  const j = await sendFile<Uploaded | null>("api/uploads", { "x-upload-id": uploadId, "x-upload-name": encodeURIComponent(name) }, p, name, onProgress, signal);
  return j || { name, size: p.size, isImage: isPicture(p) };
}

// One raw POST of a picked file to a Jarvis route (staging, or a content store's api/content/<store>/file).
export async function sendFile<T = any>(path: string, headers: Record<string, string>, p: Picked, name: string, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<T | null> {
  const task = new UploadTask(new File(p.uri!), url(path), {
    httpMethod: "POST", uploadType: UploadType.BINARY_CONTENT, signal,
    headers: { ...(await authHeaders()), "Content-Type": "application/octet-stream", ...headers },
    onProgress: (e) => { if (e.totalBytes && onProgress) onProgress(Math.round((e.bytesSent / e.totalBytes) * 100)); },
  });
  let r;
  try { r = await task.uploadAsync(); }
  catch (e: any) { if (signal?.aborted) throw new Error("cancelled"); throw networkError("POST", path + " (" + name + ")", e); }
  if (r.status < 200 || r.status >= 300) throw httpError("POST", path, r.status, r.body || "");
  try { return JSON.parse(r.body || "{}"); } catch { return null; }
}
