import fs from "node:fs";

export interface FdStats {
  used: number;
  max: number | null;
}

// Reports open file-descriptor usage in pure JS, matching the previous native contract.
// - used: number of entries in /proc/self/fd (Linux). macOS/BSD have no /proc, so used is 0
//   there, exactly as the native /proc-based counter behaved.
// - max:  the soft RLIMIT_NOFILE from process.report ("unlimited" -> null), on all platforms.
export function collectFdStats(): FdStats {
  let used = 0;
  try {
    // readdirSync itself opens one transient fd while reading the directory, so the count
    // includes it -- the same off-by-one the native opendir-based counter had.
    used = fs.readdirSync("/proc/self/fd").length;
  } catch {
    used = 0;  // no /proc/self/fd (e.g. macOS)
  }

  let max: number | null = null;
  try {
    const report = process.report?.getReport() as unknown as
      {userLimits?: {open_files?: {soft?: number | string}}} | undefined;
    const soft = report?.userLimits?.open_files?.soft;

    if (typeof soft === "number") {
      max = soft;
    } else if (typeof soft === "string" && soft !== "unlimited") {
      const parsed = Number(soft);
      max = Number.isFinite(parsed) ? parsed : null;
    }
  } catch {
    max = null;
  }

  return {used, max};
}
