// ENV=development logs every story and every batch saved as the run goes;
// otherwise (as on CI) a run logs only its start, its problems and the final
// report.
export const isDev = process.env.ENV === "development";

// A rule between the parts of a run's log.
export function line() {
  console.log("-".repeat(79));
}

// A duration for the logs: "1h 02m 05s", "3m 12s", "45s".
export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}
