// First-prompt attachments, web version (files.native.ts is the app's): pick, shrink, upload.
// Each file is uploaded to staging (api/uploads) the moment it is picked, one raw request per file,
// with progress. Content-Type is forced to octet-stream so Jarvis's express.json() never intercepts
// a JSON/text file's bytes.
import { url, httpError, networkError } from "./api";

export type Picked = { name: string; size: number; type: string; file?: File; uri?: string };
export type Uploaded = { name: string; size: number; isImage: boolean };

export const isPicture = (f: { name: string; type: string }) => /^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
// Pictures are re-encoded to a JPEG of at most IMG_MAX_EDGE px before upload when they are big,
// oversized or HEIC: a phone photo is often 5-15 MB, Claude downsizes past ~1568 px anyway, and
// HEIC is not an image format Claude (or the TUI's inline attach) can use.
export const IMG_MAX_EDGE = 2048, IMG_KEEP_BYTES = 1.5 * 1024 * 1024;

export function fromFiles(list: FileList | File[] | null): Picked[] {
  return list ? Array.from(list).map((f) => ({ name: f.name, size: f.size, type: f.type, file: f })) : [];
}

// the app has a second picker for documents (Files); in the browser the one chooser does both
export const pickDocuments = null as null | (() => Promise<Picked[]>);

/** The browser's file chooser; resolves with what was picked (nothing on cancel). */
export function pickFiles(): Promise<Picked[]> {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file"; i.multiple = true; i.style.display = "none";
    i.onchange = () => { resolve(fromFiles(i.files)); i.remove(); };
    i.addEventListener("cancel", () => { resolve([]); i.remove(); });
    document.body.appendChild(i); i.click();
  });
}

export async function shrink(p: Picked): Promise<Picked> {
  const f = p.file!;
  if (!isPicture(p)) return p;
  try {
    const bmp = await createImageBitmap(f); // applies the EXIF orientation
    const heic = /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
    if (!heic && f.size <= IMG_KEEP_BYTES && Math.max(bmp.width, bmp.height) <= IMG_MAX_EDGE) return p;
    const k = Math.min(1, IMG_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    if (!blob || (!heic && blob.size >= f.size)) return p;
    const out = new File([blob], f.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" });
    return { name: out.name, size: out.size, type: out.type, file: out };
  } catch { return p; } // undecodable here: send it as is
}

export function upload(uploadId: string, p: Picked, name: string, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<Uploaded> {
  return sendFile("api/uploads", { "x-upload-id": uploadId, "x-upload-name": encodeURIComponent(name) }, p, name, onProgress, signal);
}

// One raw POST of a picked file to a Jarvis route (staging, or a content store's api/content/<store>/file).
export function sendFile<T = any>(path: string, headers: Record<string, string>, p: Picked, name: string, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal?.addEventListener("abort", () => { xhr.abort(); reject(new Error("cancelled")); });
    xhr.open("POST", url(path));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let j: any = {}; try { j = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(j as T);
      else if (xhr.status === 0) reject(networkError("POST", path, null));
      else reject(httpError("POST", path, xhr.status, xhr.responseText || ""));
    };
    xhr.onerror = () => reject(networkError("POST", path + " (" + name + ")", null));
    xhr.send(p.file!);
  });
}
