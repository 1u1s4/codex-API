import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseVersionTag(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());

  if (!match) {
    return null;
  }

  return match.slice(1).map((value) => Number(value));
}

export function sortVersionTags(tags) {
  return [...tags].sort((left, right) => {
    const leftVersion = parseVersionTag(left);
    const rightVersion = parseVersionTag(right);

    if (!leftVersion || !rightVersion) {
      return left.localeCompare(right);
    }

    for (let index = 0; index < leftVersion.length; index += 1) {
      const difference = leftVersion[index] - rightVersion[index];
      if (difference !== 0) {
        return difference;
      }
    }

    return left.localeCompare(right);
  });
}

export function getPreviousTag(tags, currentTag) {
  const canonicalTags = sortVersionTags(tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)));
  const currentIndex = canonicalTags.indexOf(currentTag);

  if (currentIndex <= 0) {
    return null;
  }

  return canonicalTags[currentIndex - 1] ?? null;
}

function cleanupCommitText(subject) {
  return subject
    .replace(/^\w+:\s*/u, "")
    .replace(/\bCLI\b/g, "CLI")
    .replace(/\bSDK\b/g, "SDK")
    .replace(/\bREADME\b/g, "README")
    .replace(/\bOAuth\b/g, "OAuth")
    .replace(/\bSSE\b/g, "SSE")
    .replace(/\bnpm\b/g, "npm")
    .trim();
}

function translateCommonPhrases(text) {
  return text
    .replace(/CLI support from the SDK/gi, "el soporte CLI del SDK")
    .replace(/spanish branding and README/gi, "el branding en español y el README")
    .replace(/spanish release note generation/gi, "la generación de release notes en español")
    .replace(/spanish release notes/gi, "las release notes en español")
    .replace(/npm release workflow/gi, "el flujo de release de npm")
    .replace(/Gemini integration and docs cleanup/gi, "la integración con Gemini y la limpieza de documentación")
    .replace(/release workflow for npm and GitHub release/gi, "el flujo de release para npm y GitHub Releases")
    .replace(/Codex CLI backend with session persistence/gi, "el backend CLI de Codex con persistencia de sesión")
    .replace(/Gemini support \(auth, client, utils\)/gi, "soporte para Gemini (auth, client, utils)")
    .replace(/OpenAI-compatible server, CLI and adapters/gi, "el servidor compatible con OpenAI, la CLI y los adaptadores")
    .replace(/tools\/toolChoice support and docs/gi, "el soporte para tools/toolChoice y la documentación")
    .replace(/Switch to library-only API; remove CLI\/server/gi, "cambia a una API solo de librería; elimina CLI/server")
    .replace(/Initial Codex OpenAI API scaffold/gi, "scaffold inicial de Codex OpenAI API")
    .replace(/Initial commit/gi, "commit inicial")
    .replace(/ and docs/gi, " y la documentación");
}

function applySpanishVerbRules(text) {
  return translateCommonPhrases(
    text
      .replace(/^add\s+/i, "agrega ")
      .replace(/^remove\s+/i, "elimina ")
      .replace(/^improve\s+/i, "mejora ")
      .replace(/^automate\s+/i, "automatiza ")
      .replace(/^update\s+/i, "actualiza ")
      .replace(/^prepare\s+/i, "prepara ")
      .replace(/^fix\s+/i, "corrige ")
      .replace(/^document\s+/i, "documenta ")
      .replace(/^cleanup\s+/i, "limpia "),
  );
}

export function normalizeCommitSubject(subject) {
  const mergeMatch = /^Merge pull request #(\d+) from (.+)$/i.exec(subject);
  if (mergeMatch) {
    return {
      section: "Cambios integrados",
      text: `merge del PR #${mergeMatch[1]} desde ${mergeMatch[2]}`,
    };
  }

  const revertMatch = /^Revert\s+"(.+)"$/i.exec(subject);
  if (revertMatch) {
    return {
      section: "Correcciones",
      text: `revierte: ${normalizeCommitSubject(revertMatch[1]).text}`,
    };
  }

  const conventionalMatch = /^(feat|fix|docs|chore|refactor|test|ci):\s*(.+)$/i.exec(subject);
  if (conventionalMatch) {
    const [, kind, rawText] = conventionalMatch;
    const text = applySpanishVerbRules(cleanupCommitText(rawText));
    const sectionByKind = {
      feat: "Nuevas funcionalidades",
      fix: "Correcciones",
      docs: "Documentación",
      chore: "Mantenimiento",
      refactor: "Refactorización",
      test: "Pruebas",
      ci: "Integración continua",
    };

    return {
      section: sectionByKind[kind.toLowerCase()] ?? "Otros cambios",
      text,
    };
  }

  return {
    section: "Otros cambios",
    text: applySpanishVerbRules(subject.trim()),
  };
}

export function buildReleaseNotes({ currentTag, previousTag, repo, commits }) {
  const grouped = new Map();

  for (const subject of commits) {
    const normalized = normalizeCommitSubject(subject);
    if (!grouped.has(normalized.section)) {
      grouped.set(normalized.section, []);
    }
    grouped.get(normalized.section).push(normalized.text);
  }

  const lines = [];
  lines.push("## Resumen");

  if (previousTag) {
    lines.push(`- release automático de ${currentTag}`);
    lines.push(`- cambios incluidos desde ${previousTag}`);
  } else {
    lines.push(`- primera release pública etiquetada como ${currentTag}`);
  }

  lines.push(`- commits destacados incluidos: ${commits.length}`);
  lines.push("");
  lines.push("## Cambios destacados");

  if (grouped.size === 0) {
    lines.push("- Sin commits adicionales para listar.");
  } else {
    for (const [section, items] of grouped.entries()) {
      lines.push(`### ${section}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }

  lines.push("");
  lines.push("## Enlaces");
  lines.push(`- npm: https://www.npmjs.com/package/codex-openai-api`);
  lines.push(`- release: https://github.com/${repo}/releases/tag/${currentTag}`);

  if (previousTag) {
    lines.push(`- changelog completo: https://github.com/${repo}/compare/${previousTag}...${currentTag}`);
  }

  return `${lines.join("\n")}\n`;
}

export function generateReleaseNotes({ currentTag, repo }) {
  const tags = git(["tag", "--list", "v*"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  const previousTag = getPreviousTag(tags, currentTag);
  const rangeArgs = previousTag
    ? ["log", "--first-parent", "--pretty=format:%s", `${previousTag}..${currentTag}`]
    : ["log", "--first-parent", "--pretty=format:%s", currentTag];

  const versionLike = new RegExp(`^v?${currentTag.replace(/^v/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const commits = git(rangeArgs)
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((subject) => !versionLike.test(subject));

  return buildReleaseNotes({
    currentTag,
    previousTag,
    repo,
    commits,
  });
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  const currentTag = process.env.GITHUB_REF_NAME ?? process.argv[2];
  const repo = process.env.GITHUB_REPOSITORY ?? "1u1s4/codex-API";

  if (!currentTag) {
    throw new Error("GITHUB_REF_NAME is required to generate release notes.");
  }

  process.stdout.write(generateReleaseNotes({ currentTag, repo }));
}
