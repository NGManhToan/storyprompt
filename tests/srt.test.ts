import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSrt } from "../src/core/srt.js";

const sample = readFileSync(new URL("../public/samples/nha-ben-song-20.srt", import.meta.url), "utf8");

describe("parseSrt", () => {
  it("groups the sample by scene headings", () => {
    const parsed = parseSrt(sample);
    expect(parsed.scenes).toHaveLength(20);
    expect(parsed.scenes.map((scene) => scene.sceneId)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(3, "0")),
    );
    expect(parsed.scenes[0].source).toContain("Lan đặt ấm trà");
    expect(parsed.scenes[0].source).toContain("Nước sôi rồi");
    expect(parsed.scenes[0].cueIndexes).toEqual([1, 2]);
    expect(parsed.scenes[0].title).toContain("CĂN BẾP");
  });

  it("accepts dot milliseconds and a leading BOM", () => {
    const parsed = parseSrt("\uFEFF1\n00:00:01.000 --> 00:00:04.500\nCẢNH 7. EXT. SÂN\nMột chiếc xe đạp dựng dưới hiên.\n");
    expect(parsed.scenes).toHaveLength(1);
    expect(parsed.scenes[0].sceneId).toBe("007");
    expect(parsed.scenes[0].source).toContain("xe đạp");
  });

  it("treats each cue as a scene when no heading exists", () => {
    const parsed = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nLan mở cửa.\n\n2\n00:00:02,000 --> 00:00:03,000\nMinh gật đầu.\n");
    expect(parsed.scenes.map((scene) => scene.sceneId)).toEqual(["001", "002"]);
    expect(parsed.warnings.join(" ")).toMatch(/mỗi cue/i);
  });

  it("disambiguates duplicate scene numbers", () => {
    const parsed = parseSrt(
      "1\n00:00:01,000 --> 00:00:02,000\nCẢNH 4. INT. BẾP\nLan rót nước.\n\n2\n00:00:03,000 --> 00:00:04,000\nCẢNH 4. EXT. SÂN\nMinh gọi.\n",
    );
    expect(parsed.scenes.map((scene) => scene.sceneId)).toEqual(["004", "004-2"]);
    expect(parsed.warnings.some((warning) => warning.includes("004-2"))).toBe(true);
  });

  it("returns no scenes for an empty file", () => {
    expect(parseSrt("   ").scenes).toEqual([]);
  });
});
