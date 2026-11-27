import { describe, expect, it } from "vitest";
import { normalizeVisibleCast } from "../src/core/cast.js";
import { toFlowSheet } from "../src/core/export.js";
import { composeFlowPrompt, DEFAULT_CHARACTERS, FLOW_STYLE_FOOTER, referencesFor, tagCast } from "../src/core/flow.js";
import { buildSceneRequest } from "../src/core/prompts.js";
import type { Scene, SceneDraft, SceneResult, SceneTask } from "../src/core/types.js";
import { emptyResult } from "../src/core/types.js";
import { validateDraft } from "../src/core/validators.js";

const ROSTER = DEFAULT_CHARACTERS;

describe("Flow prompt format", () => {
  it("tags on-camera roster names with @ once, and maps second-person You", () => {
    expect(tagCast("Medium shot of Derek holding the phone at the counter.", ["Derek"])).toBe("Medium shot of @Derek holding the phone at the counter.");
    expect(tagCast("Medium shot of @Derek holding the phone.", ["Derek"])).toBe("Medium shot of @Derek holding the phone.");
    expect(tagCast("Point-of-view shot of your hand pressing the power button.", ["You"])).toBe("Point-of-view shot of @You's hand pressing the power button.");
    expect(tagCast("Over-the-shoulder shot from behind @you at the desk.", ["You"])).toBe("Over-the-shoulder shot from behind @You at the desk.");
    // Tên không trong khung thì không gắn.
    expect(tagCast("Arthur wipes his hands near the car.", [])).toBe("Arthur wipes his hands near the car.");
  });

  it("composes prompt + style block and lists the reference images in roster order", () => {
    const prompt = composeFlowPrompt("Medium shot of Arthur showing the worn clutch plate to you in the garage.", ["You", "Arthur"], "", FLOW_STYLE_FOOTER);
    expect(prompt).toContain("@Arthur");
    expect(prompt).toContain("@You");
    expect(prompt.endsWith(FLOW_STYLE_FOOTER)).toBe(true);
    expect(composeFlowPrompt("wide shot of the empty kitchen.", [], "", "")).toBe("Wide shot of the empty kitchen.");
    expect(referencesFor(["Arthur", "You"], ROSTER)).toEqual(["You", "Arthur"]);
  });

  it("exports a paste sheet with per-scene references", () => {
    const scenes = [
      { sceneId: "088", title: "Garage", source: "Arthur wiped his hands and told you.", start: "00:11:44,000", end: "00:11:52,000" },
      { sceneId: "089", title: "Bay", source: "The car sat in the bay.", start: "00:11:52,000", end: "00:12:00,000" },
    ] as unknown as Scene[];
    const results: SceneResult[] = [
      { ...emptyResult(scenes[0]), status: "accepted", prompt: "Medium shot of @Arthur wiping his hands beside @You in the garage.", visibleCast: ["Arthur", "You"] },
      { ...emptyResult(scenes[1]), status: "accepted", prompt: "Wide shot of the luxury car parked in the dim garage bay.", visibleCast: [] },
    ];
    const sheet = toFlowSheet(scenes, results, { prefix: "", footer: FLOW_STYLE_FOOTER, roster: ROSTER, aspectRatio: "16:9" });
    expect(sheet).toContain("=== Cảnh 088");
    expect(sheet).toContain("Ảnh tham chiếu: @You, @Arthur");
    expect(sheet).toContain("Ảnh tham chiếu: (không có nhân vật)");
    expect(sheet).toContain("16:9");
  });
});

describe("validators for Flow tags", () => {
  const task: SceneTask = {
    sceneId: "088",
    title: "Garage",
    source: "Arthur wiped his hands on a greasy shop rag and told you that the former owner rented the car.",
    likelyPresent: ["Arthur", "You"],
    neighbors: [],
  };
  const draft = (prompt: string, cast: string[]): SceneDraft => ({
    scene_id: "088",
    title: "Garage",
    environment: "Repair shop",
    prompt,
    visible_cast: cast,
    source_anchor: "Arthur wiped his hands on a greasy shop rag",
  });

  it("accepts @Name for roster names", () => {
    const ok = validateDraft(
      draft("Medium shot of @Arthur wiping his hands on a greasy shop rag while @You listens beside the lifted car, inside the cramped repair shop under hard overhead fluorescent light.", ["Arthur", "You"]),
      task,
      ROSTER,
      [],
      new Map(),
    );
    expect(ok.rejections).toEqual([]);
  });

  it("rejects @tags that are not on the roster", () => {
    const bad = validateDraft(
      draft("Medium shot of @Arthur wiping his hands on a greasy shop rag while @Mechanic listens beside the lifted car, inside the cramped repair shop under hard overhead fluorescent light.", ["Arthur", "You"]),
      task,
      ROSTER,
      [],
      new Map(),
    );
    expect(bad.rejections.some((item) => item.code === "appearanceOverride" && item.detail.includes("@Mechanic"))).toBe(true);
  });

  it("maps 'The Protagonist' to You when You is on the roster", () => {
    expect(normalizeVisibleCast(["The Protagonist", "narrator"], ROSTER)).toEqual(["You"]);
    expect(normalizeVisibleCast(["@you", "@Derek"], ROSTER)).toEqual(["You", "Derek"]);
    expect(normalizeVisibleCast(["The Protagonist"], ["Derek"])).toEqual(["The Protagonist"]);
  });

  it("tells the model about @You only when You is on the roster", () => {
    const withYou = buildSceneRequest({ tasks: [task], knownNames: ROSTER, maxOutputTokens: 4096, temperature: 0.7 });
    expect(withYou.promptText).toContain("@You");
    const without = buildSceneRequest({ tasks: [task], knownNames: ["Lan"], maxOutputTokens: 4096, temperature: 0.7 });
    expect(without.promptText).not.toContain("@You");
  });
});
