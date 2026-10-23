/** Hands the browser a file to save, as a download. Characters Windows refuses in a file name become "_". */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file name the API gives a download (`content-disposition: attachment; filename="…"`), or `fallback`. */
export function fileNameOf(contentDisposition: string | null, fallback: string): string {
  const match = contentDisposition && /filename="?([^";]+)"?/i.exec(contentDisposition);
  return match ? match[1].trim() : fallback;
}
