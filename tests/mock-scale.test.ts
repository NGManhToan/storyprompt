import { describe, expect, it } from "vitest";
import { draftFromTask } from "../src/core/providers/mock.js";
import type { SceneTask } from "../src/core/types.js";
import { countWords } from "../src/core/types.js";
import { visualKey } from "../src/core/validators.js";

describe("mock prompts stay unique past the first twenty scenes", () => {
  it("does not reuse a visual key across 176 scenes", () => {
    const keys = new Set<string>();
    for (let number = 1; number <= 176; number += 1) {
      const sceneId = String(number).padStart(3, "0");
      const task: SceneTask = {
        sceneId,
        title: `Scene ${sceneId}`,
        source: "Lan đặt ấm trà sắt xuống bàn gỗ.\nLAN: Xong phần này.",
        likelyPresent: ["Lan"],
        neighbors: [],
      };
      const draft = draftFromTask(task, ["Lan"]);
      const key = visualKey(draft.environment, draft.prompt);
      expect(keys.has(key), sceneId).toBe(false);
      keys.add(key);
      expect(countWords(draft.prompt)).toBeGreaterThanOrEqual(28);
      expect(countWords(draft.prompt)).toBeLessThanOrEqual(42);
    }
  });
});
