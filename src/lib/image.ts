// ─── Photo re-encode (Requirement 1.4) ─────────────────────────────────────────
//
// Draws the photo onto a canvas and exports a new file. Canvas output carries no
// EXIF block, so GPS and camera metadata are dropped structurally. The longest
// side is capped to keep data URLs small enough to store in the items table.

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF orientation before the metadata is lost.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> path (e.g. older Safari).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-encode `file` as WebP (JPEG where WebP encoding is unsupported). Throws if it can't be decoded. */
export async function reencodeImage(file: File, maxSide = 1600): Promise<string> {
  const source = await decode(file);
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.drawImage(source, 0, 0, width, height);
  if ("close" in source && typeof source.close === "function") source.close();

  const webp = canvas.toDataURL("image/webp", 0.85);
  // Browsers without a WebP encoder silently return PNG; JPEG is much smaller.
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}
