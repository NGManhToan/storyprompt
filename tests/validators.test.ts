import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractNames, inferPresence } from "../src/core/cast.js";
import { parseSrt } from "../src/core/srt.js";
import type { SceneDraft, SceneTask } from "../src/core/types.js";
import { validateDraft, visualKey } from "../src/core/validators.js";

const sample = readFileSync(new URL("../public/samples/nha-ben-song-20.srt", import.meta.url), "utf8");
const parsed = parseSrt(sample);
const names = extractNames(parsed.scenes.map((scene) => scene.source).join("\n"));

function task(source: string, id = "001", neighbors: SceneTask["neighbors"] = []): SceneTask {
  return {
    sceneId: id,
    title: "Test",
    source,
    likelyPresent: inferPresence(source, names).present,
    neighbors,
  };
}

function draft(partial: Partial<SceneDraft> & Pick<SceneDraft, "prompt" | "visible_cast">): SceneDraft {
  return {
    scene_id: "001",
    title: "Scene",
    environment: "Kitchen",
    source_anchor: "Lan đặt ấm trà sắt xuống bàn gỗ.",
    ...partial,
  };
}

const GOOD =
  "Lan lowers the iron teapot onto the scarred wooden table as rain threads the dark kitchen glass, medium shot at eye level with shallow focus and a practical lamp.";

describe("cast", () => {
  it("reads names from the script instead of a hard-coded roster", () => {
    expect(names).toEqual(expect.arrayContaining(["Lan", "Minh", "Hải"]));
    expect(names).not.toContain("Derek");
    expect(names).not.toContain("Chloe");
  });

  it("keeps a mentioned character out of the frame", () => {
    const scene = parsed.scenes[2];
    const presence = inferPresence(scene.source, names);
    expect(presence.present).toEqual(["Lan", "Minh"]);
    expect(presence.mentionedOnly).toEqual(["Hải"]);
  });

  it("drops someone who has left the frame", () => {
    const scene = parsed.scenes[17];
    expect(inferPresence(scene.source, names).present).toEqual(["Lan"]);
  });

  it("treats voice-over as off camera", () => {
    const presence = inferPresence("HẢI (V.O.): Con nhớ giữ nhà.\nLan mở cửa sổ nhìn ra sân vườn.", ["Hải", "Lan"]);
    expect(presence.present).toEqual(["Lan"]);
    expect(presence.mentionedOnly).toContain("Hải");
  });
});

describe("validateDraft", () => {
  const source = parsed.scenes[0].source;
  const base = task(source);

  it("accepts a concrete English prompt", () => {
    const result = validateDraft(
      draft({ prompt: GOOD, visible_cast: ["Lan"], source_anchor: "Lan đặt ấm trà sắt xuống bàn gỗ." }),
      base,
      names,
      [],
      new Map(),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects word counts outside 28–42", () => {
    const short = validateDraft(draft({ prompt: "Lan stands in the kitchen.", visible_cast: ["Lan"] }), base, names, [], new Map());
    expect(short.rejections.map((item) => item.code)).toContain("wordCount");
    const words = GOOD.split(/\s+/);
    const long = `${words.concat(words).join(" ").replace(/\.$/, "")}.`;
    const tooLong = validateDraft(draft({ prompt: long, visible_cast: ["Lan"] }), base, names, [], new Map());
    expect(tooLong.rejections.map((item) => item.code)).toContain("wordCount");
  });

  it("rejects a truncated ending", () => {
    const prompt = GOOD.replace(/\.$/, " and");
    const result = validateDraft(draft({ prompt, visible_cast: ["Lan"] }), base, names, [], new Map());
    expect(result.rejections.map((item) => item.code)).toContain("incompleteEnding");
  });

  it("rejects Vietnamese and overlay text", () => {
    const language = validateDraft(
      draft({ prompt: "Lan đứng trong bếp nhìn mưa rơi ngoài cửa kính và giữ im lặng rất lâu trong đêm.", visible_cast: ["Lan"] }),
      base,
      names,
      [],
      new Map(),
    );
    expect(language.rejections.map((item) => item.code)).toContain("wrongLanguage");
    const overlay = validateDraft(
      draft({
        prompt: `${GOOD.replace(/\.$/, "")} with a subtitle that reads "home".`.replace("  ", " "),
        visible_cast: ["Lan"],
      }),
      base,
      names,
      [],
      new Map(),
    );
    expect(overlay.rejections.map((item) => item.code)).toContain("overlayText");
  });

  it("rejects appearance tags and unnamed stand-ins", () => {
    const tagged = validateDraft(
      draft({ prompt: GOOD.replace("Lan", "@Lan #FFFFFF"), visible_cast: ["Lan"] }),
      base,
      names,
      [],
      new Map(),
    );
    expect(tagged.rejections.map((item) => item.code)).toContain("appearanceOverride");
    const unnamed = validateDraft(
      draft({
        prompt: GOOD.replace("Lan lowers", "A woman lowers"),
        visible_cast: ["Lan"],
      }),
      base,
      names,
      [],
      new Map(),
    );
    expect(unnamed.rejections.map((item) => item.code)).toContain("unnamedCharacter");
  });

  it("rejects a character who is only talked about", () => {
    const scene = parsed.scenes[2];
    const result = validateDraft(
      draft({
        scene_id: scene.sceneId,
        prompt: "Lan and Minh sit with Hải at the table while the kettle cools, medium shot at eye level with shallow focus and a practical lamp.",
        visible_cast: ["Lan", "Minh", "Hải"],
        source_anchor: "Lan và Minh ngồi đối diện.",
      }),
      task(scene.source, scene.sceneId),
      names,
      [],
      new Map(),
    );
    expect(result.rejections.some((item) => item.code === "castAbsent" && item.detail.includes("Hải"))).toBe(true);
  });

  it("rejects an anchor borrowed from the neighbor", () => {
    const neighbor = parsed.scenes[1];
    const result = validateDraft(
      draft({
        prompt: GOOD,
        visible_cast: ["Lan"],
        source_anchor: "Minh đứng ở ngưỡng cửa và gấp ô lại.",
      }),
      task(source, "001", [{ sceneId: "002", title: neighbor.title, source: neighbor.source }]),
      names,
      [],
      new Map(),
    );
    expect(result.rejections.map((item) => item.code)).toContain("borrowedAction");
  });

  it("rejects a repeated action phrase and a repeated visual key", () => {
    const copied = "Lan lowers the iron teapot onto the scarred wooden table as rain threads the dark kitchen glass, medium shot.";
    const neighborPrompt = `${copied.replace(/\.$/, "")} with shallow focus and a practical lamp.`;
    const result = validateDraft(
      draft({ prompt: GOOD, visible_cast: ["Lan"] }),
      base,
      names,
      [{ sceneId: "002", prompt: neighborPrompt }],
      new Map([[visualKey("Kitchen", GOOD), "009"]]),
    );
    const codes = result.rejections.map((item) => item.code);
    expect(codes).toContain("borrowedAction");
    expect(codes).toContain("duplicateVisualKey");
  });
});
