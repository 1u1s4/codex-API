import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const currentTag = process.env.GITHUB_REF_NAME ?? process.argv[2];
const repo = process.env.GITHUB_REPOSITORY ?? "1u1s4/codex-API";

if (!currentTag) {
  throw new Error("GITHUB_REF_NAME is required to generate release notes.");
}

const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);

const previousTag = tags.find((tag) => tag !== currentTag) ?? null;
const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;

const rawCommits = git(["log", "--pretty=format:%s", range])
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);

const versionLike = new RegExp(`^v?${escapeRegExp(currentTag.replace(/^v/, ""))}$`, "i");
const commits = rawCommits.filter((subject) => !versionLike.test(subject));

const lines = [];
lines.push("## Cambios principales");

if (previousTag) {
  lines.push(`- release automático de ${currentTag}`);
  lines.push(`- cambios incluidos desde ${previousTag}`);
} else {
  lines.push(`- primera release pública etiquetada como ${currentTag}`);
}

lines.push("");
lines.push("## Commits incluidos");

if (commits.length === 0) {
  lines.push("- Sin commits adicionales para listar.");
} else {
  for (const subject of commits) {
    lines.push(`- ${subject}`);
  }
}

lines.push("");
lines.push("## Enlaces");
lines.push(`- npm: https://www.npmjs.com/package/codex-openai-api`);
lines.push(`- release: https://github.com/${repo}/releases/tag/${currentTag}`);

if (previousTag) {
  lines.push(`- changelog completo: https://github.com/${repo}/compare/${previousTag}...${currentTag}`);
}

process.stdout.write(`${lines.join("\n")}\n`);
