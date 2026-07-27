import { type App } from "@modelcontextprotocol/ext-apps";

export interface TextFileDownload {
  /** Name the host should save the file under. */
  filename: string;
  mimeType: string;
  text: string;
}

/**
 * Whether the host will accept `ui/download-file`. Apps must gate their export
 * affordance on this — a download button that silently does nothing is worse
 * than no button.
 */
export function canDownloadFiles(app: App | null): boolean {
  return app?.getHostCapabilities()?.downloadFile !== undefined;
}

/**
 * Hand a text document to the host to save.
 *
 * @returns `false` when the host declined or the user cancelled.
 */
export async function downloadTextFile(
  app: App,
  file: TextFileDownload,
): Promise<boolean> {
  const result = await app.downloadFile({
    contents: [
      {
        resource: {
          mimeType: file.mimeType,
          text: file.text,
          uri: `file:///${file.filename}`,
        },
        type: "resource",
      },
    ],
  });
  return result.isError !== true;
}

/** Quote a CSV field only when RFC 4180 requires it. */
function escapeCsvField(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Serialize records to RFC 4180 CSV.
 *
 * `columns` fixes the order; a record missing one of them contributes an empty
 * field rather than shifting the row.
 *
 * @param headers - Header labels, positionally matched to `columns`. Defaults
 *   to the column keys; pass this to give a spreadsheet reader units.
 */
export function toCsv<T>(
  rows: readonly T[],
  columns: readonly (keyof T & string)[],
  headers: readonly string[] = columns,
): string {
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvField(row[column])).join(","));
  }
  return lines.join("\n");
}
