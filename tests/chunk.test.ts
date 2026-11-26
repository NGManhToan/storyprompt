import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildScenes, chunkFixed } from "../src/core/chunk.js";
import { buildSceneRequest, SYSTEM_SCENES } from "../src/core/prompts.js";

const timed = [
  { start: 0, end: 3, text: "Lan đặt ấm trà xuống bàn." },
  { start: 9, end: 12, text: "Minh mở cửa." },
  { start: 12.2, end: 15, text: "Mưa vẫn rơi ngoài hiên nhà." },
];

describe("chunking from the AI Studio cutter", () => {
  it("cuts a dialogue SRT into fixed 8 second scenes", () => {
    const scenes = chunkFixed(timed, 8);
    expect(scenes.map((scene) => scene.sceneId)).toEqual(["001", "002"]);
    expect(scenes[0].source).toContain("ấm trà");
    expect(scenes[0].cutReason).toMatch(/8s/);
    expect(scenes[1].source).toContain("Minh mở cửa");
    expect(scenes[1].source).toContain("Mưa vẫn rơi");
  });

  it("keeps heading scenes for a screenplay file", () => {
    const raw = readFileSync(new URL("../public/samples/nha-ben-song-20.srt", import.meta.url), "utf8");
    const parsed = buildScenes(raw, { kind: "srt", mode: "headings" });
    expect(parsed.scenes).toHaveLength(20);
    expect(parsed.scenes[0].heading).toMatch(/CẢNH 1/i);
  });

  it("chunks plain text by line", () => {
    const parsed = buildScenes("Lan mở cửa.\n\nMinh gật đầu.", { kind: "txt", mode: "fixed", txtMode: "by_line" });
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[1].source).toBe("Minh gật đầu.");
  });
});

describe("prompt rules carried from the studio app", () => {
  it("keeps cutaway, variety, and the full script without channel-specific tokens", () => {
    expect(SYSTEM_SCENES).toMatch(/CUTAWAY/);
    expect(SYSTEM_SCENES).toMatch(/VARIETY/);
    expect(SYSTEM_SCENES).toMatch(/MASTER_SCRIPT/);
    expect(SYSTEM_SCENES).not.toMatch(/Derek|Chloe|#FFFFFF|@You/);
    const request = buildSceneRequest({
      tasks: [
        {
          sceneId: "001",
          title: "Bếp",
          source: "Lan đặt ấm trà sắt xuống bàn gỗ.",
          likelyPresent: ["Lan"],
          neighbors: [],
        },
      ],
      knownNames: ["Lan"],
      masterScript: "Toàn bộ kịch bản. Lan ở bếp. Minh ở cửa.",
      topic: "Buổi sáng yên",
      protagonist: "Lan",
      maxOutputTokens: 8192,
      temperature: 0.7,
    });
    expect(request.promptText).toContain("MASTER_SCRIPT");
    expect(request.promptText).toContain("Toàn bộ kịch bản");
    expect(request.promptText).toContain("VIDEO TOPIC");
    expect(request.promptText).not.toMatch(/Derek|Chloe|#FFFFFF|@You/);
    expect(request.temperature).toBe(0.7);
  });
});
