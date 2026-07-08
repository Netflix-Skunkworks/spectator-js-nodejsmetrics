import fs from "node:fs";

export interface FdStats {
  used: number;
  max: number | null;
}

// Reports open file-descriptor usage in pure JS, matching the previous native contract.
// - used: number of entries in /proc/self/fd (Linux). macOS/BSD have no /proc, so used is 0
//   there, exactly as the native /proc-based counter behaved.
// - max:  the soft RLIMIT_NOFILE from /proc/self/limits (Linux). Other platforms report null,
//   keeping this collector Linux-only like the old /proc-based native implementation.
export function collectFdStats(): FdStats {
  let used = 0;
  try {
    // readdirSync itself opens one transient fd while reading the directory, so the count
    // includes it -- the same off-by-one the native opendir-based counter had.
    used = fs.readdirSync("/proc/self/fd").length;
  } catch {
    used = 0;  // no /proc/self/fd (e.g. macOS)
  }

  return {used, max: collectMaxFd()};
}

function parseSoftLimit(soft: string | undefined): number | null {
  if (!soft || soft === "unlimited") {
    return null;
  }
  const parsed = Number(soft);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectMaxFd(): number | null {
  if (process.platform !== "linux") {
    return null;
  }

  let max: number | null = null;
  try {
    const limits = fs.readFileSync("/proc/self/limits", "utf8");
    const line = limits.split("\n").find((entry: string): boolean => entry.startsWith("Max open files"));
    max = parseSoftLimit(line?.trim().split(/\s+/)[3]);
  } catch {
    max = null;
  }
  return max;
}
