import fs from "node:fs/promises";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
}

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  await ensureParentDir(filePath);

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, { encoding: "utf8", mode: FILE_MODE });
  await fs.rename(tempPath, filePath);

  try {
    await fs.chmod(filePath, FILE_MODE);
  } catch {
    // Best-effort permission hardening.
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
