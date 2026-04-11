import { describe, expect, it } from "vitest";
import {
  buildReleaseNotes,
  getPreviousTag,
  normalizeCommitSubject,
  sortVersionTags,
} from "../scripts/generate-release-notes.mjs";

describe("release notes automation", () => {
  it("sorts canonical version tags semantically", () => {
    expect(sortVersionTags(["v0.10.0", "v0.2.0", "v0.1.0"])).toEqual([
      "v0.1.0",
      "v0.2.0",
      "v0.10.0",
    ]);
  });

  it("finds the previous canonical tag", () => {
    expect(getPreviousTag(["v0.1.0", "v0.2.0", "v0.10.0"], "v0.2.0")).toBe("v0.1.0");
    expect(getPreviousTag(["v0.1.0"], "v0.1.0")).toBeNull();
  });

  it("normalizes conventional commits to spanish sections", () => {
    expect(normalizeCommitSubject("feat: remove CLI support from the SDK (#7)")).toEqual({
      section: "Nuevas funcionalidades",
      text: "elimina el soporte CLI del SDK (#7)",
    });

    expect(normalizeCommitSubject("Merge pull request #8 from 1u1s4/chore/spanish-release-notes-automation")).toEqual({
      section: "Cambios integrados",
      text: "merge del PR #8 desde 1u1s4/chore/spanish-release-notes-automation",
    });
  });

  it("builds spanish release notes with canonical compare links", () => {
    const notes = buildReleaseNotes({
      currentTag: "v0.2.0",
      previousTag: "v0.1.0",
      repo: "1u1s4/codex-API",
      commits: [
        "chore: automate npm release workflow (#5)",
        "docs: improve spanish branding and README (#6)",
        "feat: remove CLI support from the SDK (#7)",
      ],
    });

    expect(notes).toContain("- release automático de v0.2.0");
    expect(notes).toContain("- cambios incluidos desde v0.1.0");
    expect(notes).toContain("### Mantenimiento");
    expect(notes).toContain("- automatiza el flujo de release de npm (#5)");
    expect(notes).toContain("### Documentación");
    expect(notes).toContain("- mejora el branding en español y el README (#6)");
    expect(notes).toContain("### Nuevas funcionalidades");
    expect(notes).toContain("- elimina el soporte CLI del SDK (#7)");
    expect(notes).toContain("https://github.com/1u1s4/codex-API/compare/v0.1.0...v0.2.0");
  });

  it("marks the first release explicitly", () => {
    const notes = buildReleaseNotes({
      currentTag: "v0.1.0",
      previousTag: null,
      repo: "1u1s4/codex-API",
      commits: ["Merge pull request #4 from 1u1s4/feat/cli-fast-mode-gpt54"],
    });

    expect(notes).toContain("- primera release pública etiquetada como v0.1.0");
    expect(notes).not.toContain("compare/");
  });
});
