import { toCopyText, toCsv, toFlowHandoff, toFlowSheet, toNumberedText, type FlowOptions } from "./export.js";
import type { RequestLog, RunReport, Scene, SceneResult, StoryBible } from "./types.js";

export type ExportKind = "json" | "txt" | "flow" | "flowsheet" | "numbered" | "csv";
export const EXPORT_KINDS: ExportKind[] = ["json", "txt", "flow", "flowsheet", "numbered", "csv"];

export type ExportInput = {
  fileName: string;
  scenes: Scene[];
  results: SceneResult[];
  options: FlowOptions;
  names?: string[];
  bible?: StoryBible | null;
  masterScript?: string;
  report?: RunReport | null;
  logs?: RequestLog[];
};

export type ExportFile = { filename: string; body: string; mime: string };

/** Một nơi dựng file xuất cho cả trình duyệt và server (lịch sử chạy nền). */
export function buildExport(kind: ExportKind, input: ExportInput): ExportFile | null {
  const stamp = input.fileName.replace(/\.(srt|txt)$/i, "") || "storyprompt";
  const { scenes, results, options } = input;
  let file: ExportFile;
  switch (kind) {
    case "txt":
      file = { filename: `${stamp}.txt`, body: toCopyText(scenes, results, options), mime: "text/plain" };
      break;
    case "flowsheet":
      file = { filename: `${stamp}.flow.txt`, body: toFlowSheet(scenes, results, options), mime: "text/plain" };
      break;
    case "numbered":
      file = { filename: `${stamp}.numbered.txt`, body: toNumberedText(scenes, results, options), mime: "text/plain" };
      break;
    case "csv":
      file = { filename: `${stamp}.csv`, body: toCsv(scenes, results, options), mime: "text/csv" };
      break;
    case "flow":
      file = { filename: `${stamp}.flow.json`, body: JSON.stringify(toFlowHandoff(scenes, results, options), null, 2), mime: "application/json" };
      break;
    case "json":
      file = {
        filename: `${stamp}.json`,
        body: JSON.stringify(
          {
            fileName: input.fileName,
            bible: input.bible ?? undefined,
            names: input.names ?? [],
            masterScript: input.masterScript,
            scenes: scenes.map((scene) => ({ ...scene, result: results.find((row) => row.sceneId === scene.sceneId) })),
            report: input.report ?? undefined,
            logs: input.logs ?? [],
          },
          null,
          2,
        ),
        mime: "application/json",
      };
      break;
    default:
      return null;
  }
  return file.body ? file : null;
}
