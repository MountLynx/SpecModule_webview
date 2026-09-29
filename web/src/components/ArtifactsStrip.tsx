// 产物条（RunView 终态）：声明制产物清单（GET /api/runs/{id}/artifacts）的
// 下载 chips——本地/云端同一 HTTP 下载交互；清单为空不渲染。
import { FileDown } from "lucide-react";
import type { RunArtifact } from "../api";

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function ArtifactsStrip({
  runId,
  artifacts,
}: {
  runId: string;
  artifacts: RunArtifact[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-secondary/40 px-3.5 py-1.5 text-[12px]">
      <span className="shrink-0 text-muted-foreground">产物</span>
      {artifacts.map((a) => (
        <a
          key={a.index}
          href={`/api/runs/${encodeURIComponent(runId)}/artifacts/${a.index}`}
          download
          title={`${a.name} · ${a.modified}\n${a.path}`}
          className="flex items-center gap-1.5 rounded-[5px] border bg-card px-2 py-0.5 transition-colors hover:border-foreground/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FileDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className={a.kind === "deliverable" ? "font-medium" : ""}>
            {a.name}
          </span>
          <span className="text-muted-foreground">{fmtSize(a.size)}</span>
          {a.kind === "deliverable" && (
            <span className="rounded bg-[var(--ph-done-bg)] px-1 text-[10px] text-[var(--ph-done-text)]">
              交付物
            </span>
          )}
        </a>
      ))}
    </div>
  );
}
