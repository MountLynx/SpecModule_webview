import { Settings } from "lucide-react";
import type { Health } from "./types";

interface Props {
  health: Health | null;
  serviceAvailable: boolean;
}

/** 设置面板（侧边栏，全局功能）：对话服务健康状态（升自一期占位） */
export function SettingsPanel({ health, serviceAvailable }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3 text-[13px] font-semibold">设置</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-[12.5px] leading-6 text-muted-foreground">
        {!serviceAvailable ? (
          <p className="rounded-panel border border-dashed px-2.5 py-3">
            对话服务未启用——服务端未安装 treechat（`pip install -e "../Treechat"` 后重启生效）。
            运行管理功能不受影响。
          </p>
        ) : (
          <div className="space-y-2">
            <div className="rounded-panel border bg-card px-2.5 py-2">
              <div className="pb-1 font-medium text-foreground">对话服务</div>
              <div>状态：{health?.ok ? "正常" : "未知"}</div>
              <div>LLM：{health?.llmConfigured
                ? "已配置"
                : "未配置（对话轮次不可用，管理功能正常）"}</div>
              {health && <div className="break-all font-mono text-[11.5px] opacity-80">data_dir: {health.dataDir}</div>}
            </div>
            <p className="rounded-panel border border-dashed px-2.5 py-3">
              主题当前跟随系统；更多设置（模型、窗口预算、用量统计）后续版本提供。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
