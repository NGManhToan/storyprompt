import { describe, expect, it } from "vitest";
import { normalizeVisibleCast } from "../src/core/cast.js";
import { toFlowSheet } from "../src/core/export.js";
import { composeFlowPrompt, DEFAULT_CHARACTERS, FLOW_STYLE_FOOTER, referencesFor, softenBannedLight, tagCast } from "../src/core/flow.js";
import { buildSceneRequest } from "../src/core/prompts.js";
import type { Scene, SceneDraft, SceneResult, SceneTask } from "../src/core/types.js";
import { emptyResult } from "../src/core/types.js";
import { inferPresence } from "../src/core/cast.js";
import { retryFeedback, validateDraft } from "../src/core/validators.js";

const ROSTER = DEFAULT_CHARACTERS;

describe("Flow prompt format", () => {
  it("tags on-camera roster names with @ once, and maps second-person You", () => {
    expect(tagCast("Medium shot of Derek holding the phone at the counter.", ["Derek"])).toBe("Medium shot of @Derek holding the phone at the counter.");
    expect(tagCast("Medium shot of @Derek holding the phone.", ["Derek"])).toBe("Medium shot of @Derek holding the phone.");
    expect(tagCast("Point-of-view shot of your hand pressing the power button.", ["You"])).toBe("Point-of-view shot of @You's hand (pure flat white skin #FFFFFF) pressing the power button.");
    // Đã có cụm da trắng thì không thêm lần nữa.
    expect(tagCast("First-person POV of @You's hand (pure flat white skin #FFFFFF) opening the drawer.", ["You"])).toBe("First-person POV of @You's hand (pure flat white skin #FFFFFF) opening the drawer.");
    // Chỉ thêm khi bộ phận cơ thể của You là chủ thể; "@You" nguyên người thì không.
    expect(tagCast("Medium shot of @You looking at the monitor.", ["You"])).toBe("Medium shot of @You looking at the monitor.");
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
      draft("Medium shot of @Arthur wiping his hands on a greasy shop rag while @You listens beside the lifted car, inside the cramped repair shop under soft overhead light.", ["Arthur", "You"]),
      task,
      ROSTER,
      [],
      new Map(),
    );
    expect(ok.rejections).toEqual([]);
  });

  it("rejects @tags that are not on the roster", () => {
    const bad = validateDraft(
      draft("Medium shot of @Arthur wiping his hands on a greasy shop rag while @Mechanic listens beside the lifted car, inside the cramped repair shop under soft overhead light.", ["Arthur", "You"]),
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

describe("AI Studio conventions", () => {
  const task: SceneTask = {
    sceneId: "012",
    title: "Call",
    source: "Your phone vibrates on the desk, showing an incoming call from Derek. You pick up and speak directly to Derek and Chloe.",
    likelyPresent: ["You"],
    neighbors: [],
  };
  const check = (prompt: string, cast: string[]) =>
    validateDraft(
      { scene_id: "012", title: "Call", environment: "Desk", prompt, visible_cast: cast, source_anchor: "Your phone vibrates on the desk" },
      task,
      ROSTER,
      [],
      new Map(),
    ).rejections;
  const BASE = "of @You's hand picking up the vibrating phone from the wooden desk beside the laptop, the screen showing a caller name, in soft daylight from the window.";

  it("keeps people who are only heard by phone/message out of frame", () => {
    const presence = inferPresence(task.source, ROSTER);
    expect(presence.present).toContain("You");
    expect(presence.present).not.toContain("Derek");
    expect(presence.present).not.toContain("Chloe");
    expect(presence.mentionedOnly).toEqual(expect.arrayContaining(["Derek", "Chloe"]));
    // Derek tự hành động bên phía anh ta (không có You trong mệnh đề) vẫn được hiện.
    expect(inferPresence("Derek argues into his phone at his desk.", ROSTER).present).toContain("Derek");
    // Cảnh 032 của file thử: không có chữ "call", chỉ "pick the phone back up and speak to".
    const second = inferPresence("You pick the phone back up and speak directly to Derek and Chloe, telling both of them to keep their breathing steady,", ROSTER);
    expect(second.present).toEqual(["You"]);
    expect(second.mentionedOnly).toEqual(expect.arrayContaining(["Derek", "Chloe"]));
    const request = buildSceneRequest({ tasks: [task], knownNames: ROSTER, maxOutputTokens: 4096, temperature: 0.7 });
    expect(request.promptText).toContain("OFF-FRAME");
    expect(request.promptText).toContain("Derek");
  });

  it("rejects drawing the remote caller and tells the model how to fix it", () => {
    const rejections = check("Medium shot of @Derek talking on the phone beside @You at the wooden desk in soft daylight from the window over the quiet kitchen.", ["Derek", "You"]);
    expect(rejections.some((item) => item.code === "castAbsent")).toBe(true);
    expect(retryFeedback(rejections)).toMatch(/phone, call or message is NOT in frame/);
    expect(check(`First-person POV ${BASE}`, ["You"])).toEqual([]);
  });

  it("rejects emotion words and cinematic-drama lighting", () => {
    for (const bad of [
      "First-person POV of @You's hand picking up the phone while dread settles over the wooden desk in soft daylight from the window by the laptop.",
      "First-person POV of @You's hand picking up the phone under the harsh blue light of the monitor on the wooden desk beside the laptop.",
      "First-person POV of @You's hand picking up the phone while flickering neon casts long shadows over the wooden desk beside the laptop.",
    ]) {
      expect(check(bad, ["You"]).map((item) => item.code)).toContain("styleClash");
    }
    expect(retryFeedback(check("First-person POV of @You's hand picking up the phone in moody light on the wooden desk by the laptop and window.", ["You"]))).toMatch(/No emotion words/);
  });

  it("allows only the AI Studio hand-skin hex and does not count it as words", () => {
    expect(check(`First-person POV of @You's hand (pure flat white skin #FFFFFF) picking up the vibrating phone from the wooden desk beside the open laptop and the coffee mug, in soft daylight from the window.`, ["You"])).toEqual([]);
    expect(check(`First-person POV of @You's hand (skin #FFAA00) picking up the vibrating phone from the wooden desk beside the open laptop and the coffee mug, in soft daylight from the window.`, ["You"]).map((item) => item.code)).toContain("appearanceOverride");
  });

  it("rejects 'a hand' / 'a person' standing in for @You", () => {
    expect(check("First-person shot of a hand picking up the vibrating phone from the wooden desk beside the laptop, in soft daylight from the window.", ["You"]).map((item) => item.code)).toContain("unnamedCharacter");
    expect(check("Close-up that follows hands picking up the vibrating phone from the wooden desk beside the laptop, in soft daylight from the window.", ["You"]).map((item) => item.code)).toContain("unnamedCharacter");
  });

  it("puts the three AI Studio shot templates in the instruction only when You is on the roster", () => {
    const withYou = buildSceneRequest({ tasks: [task], knownNames: ROSTER, maxOutputTokens: 4096, temperature: 0.7 });
    expect(withYou.promptText).toContain("First-person POV of @You's hand");
    expect(withYou.promptText).toContain("Medium shot of @You looking at");
    expect(withYou.promptText).toContain("Over-the-shoulder shot from behind @You");
    expect(withYou.promptText).not.toContain("#FFFFFF");
  });

  it("adds --ar only when asked", () => {
    expect(composeFlowPrompt("wide shot of the kitchen.", [], "", "", undefined)).toBe("Wide shot of the kitchen.");
    expect(composeFlowPrompt("wide shot of the kitchen.", [], "", "", "16:9")).toBe("Wide shot of the kitchen. --ar 16:9");
  });

  it("tags leftover your/you even when @You is already present", () => {
    expect(tagCast("First-person POV of @You's hand marking a calendar toward your 35th birthday.", ["You"])).toBe(
      "First-person POV of @You's hand (pure flat white skin #FFFFFF) marking a calendar toward @You's 35th birthday.",
    );
    expect(tagCast("Medium shot of @You looking at you in the mirror.", ["You"])).toBe("Medium shot of @You looking at @You in the mirror.");
  });

  it("rewrites banned lighting words copied from the source", () => {
    const raw = "Medium shot of @You sitting at a metal desk under harsh overhead fluorescent lights, observing the stacks of paperwork and the ledger book inside the dusty, beige logistics office during the morning hours.";
    const soft = softenBannedLight(raw);
    expect(soft).toContain("plain overhead fluorescent lights");
    expect(soft).not.toMatch(/\bharsh\b/i);
    const task: SceneTask = {
      sceneId: "076",
      title: "Office",
      source: "your financial baseline began at $24 an hour, netting $48,000 a year in a regional logistics office while you sat under harsh fluorescent lights.",
      likelyPresent: ["You"],
      neighbors: [],
    };
    const verdict = validateDraft(
      { scene_id: "076", title: "Office", environment: "Logistics office", prompt: soft, visible_cast: ["You"], source_anchor: "your financial baseline began at $24 an hour" },
      task,
      ROSTER,
      [],
      new Map(),
    );
    expect(verdict.rejections).toEqual([]);
  });

});
