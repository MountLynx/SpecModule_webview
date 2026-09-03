// 模块库视图：左列表（store.list_modules 摘要）+ 右详情面板（detail_to_dict 全量）
// + 列表尾「扫描来源」只读行 + 头部「▶ 运行…」入口（RunDialog）。
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  fetchModuleDetail,
  fetchModules,
  type LaunchResult,
  type ModuleDetail,
  type ModuleInfo,
} from "../api";
import { btnStyle } from "./dialogStyles";
import { RunDialog } from "./RunDialog";

const KIND_COLOR: Record<string, string> = {
  entry: "#2563eb",
  packed: "#7c3aed",
  pip: "#0891b2",
};

const monoStyle: CSSProperties = { fontFamily: "monospace" };

interface ModulesViewProps {
  /** 启动成功（202）回调：App 切运行视图并打开新 run */
  onLaunched: (result: LaunchResult) => void;
}

export function ModulesView({ onLaunched }: ModulesViewProps) {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModuleDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchModules()
      .then((d) => {
        setModules(d.modules);
        setSearchPaths(d.search_paths);
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const select = (name: string) => {
    setSelected(name);
    setDetail(null);
    setDetailErr(null);
    fetchModuleDetail(name)
      .then(setDetail)
      .catch((e) => setDetailErr(e instanceof Error ? e.message : String(e)));
  };

  const selectedInfo = modules.find((m) => m.name === selected) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600 }}>模块库</span>
        <span style={{ color: "#6b7280" }}>{modules.length} 个模块</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {detailErr && <span style={{ color: "#b91c1c", fontSize: 12 }}>{detailErr}</span>}
          <button
            style={btnStyle}
            disabled={!detail || runOpen}
            title={detail ? `运行 ${detail.name}` : "先选择一个模块"}
            onClick={() => setRunOpen(true)}
          >
            ▶ 运行…
          </button>
        </span>
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左列表 */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            borderRight: "1px solid #e5e7eb",
            overflowY: "auto",
          }}
        >
          {modules.map((m) => (
            <div
              key={`${m.kind}:${m.name}`}
              onClick={() => select(m.name)}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                background: m.name === selected ? "#eef2ff" : undefined,
                borderBottom: "1px solid #f3f4f6",
              }}
            >
              <div style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  style={{
                    fontSize: 10,
                    padding: "0 5px",
                    borderRadius: 8,
                    color: "#fff",
                    background: KIND_COLOR[m.kind] ?? "#6b7280",
                  }}
                >
                  {m.kind}
                </span>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                {m.version && (
                  <span style={{ fontSize: 11, color: "#6b7280" }}>v{m.version}</span>
                )}
              </div>
              {m.description && (
                <div
                  style={{
                    fontSize: 11,
                    color: "#6b7280",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.description}
                </div>
              )}
            </div>
          ))}
          {!modules.length && !loadErr && (
            <div style={{ padding: 12, fontSize: 12, color: "#9ca3af" }}>未发现模块</div>
          )}
          {loadErr && (
            <div style={{ padding: 12, fontSize: 12, color: "#b91c1c" }}>
              模块列表加载失败：{loadErr}
            </div>
          )}
          {/* 扫描来源：排查「为什么看不到我的模块」 */}
          <div style={{ padding: "10px 12px", fontSize: 11, color: "#6b7280" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>扫描来源（优先序）</div>
            {searchPaths.length ? (
              searchPaths.map((p) => (
                <div key={p} style={{ ...monoStyle, wordBreak: "break-all" }}>
                  {p}
                </div>
              ))
            ) : (
              <div>（无——base_dir/modules、$SPECMODULE_PATH、store/modules 均不存在）</div>
            )}
          </div>
        </div>
        {/* 右详情面板 */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14, minWidth: 0 }}>
          {!selected && <div style={{ color: "#9ca3af" }}>选择左侧模块查看详情</div>}
          {selected && !detail && !detailErr && <div style={{ color: "#9ca3af" }}>加载中…</div>}
          {detail && <DetailPanel detail={detail} />}
        </div>
      </div>
      {runOpen && detail && (
        <RunDialog
          detail={detail}
          onClose={() => setRunOpen(false)}
          onLaunched={(r) => {
            setRunOpen(false);
            onLaunched(r);
          }}
        />
      )}
    </div>
  );
}

function DetailPanel({ detail }: { detail: ModuleDetail }) {
  const section: CSSProperties = { marginTop: 12 };
  const label: CSSProperties = { fontWeight: 600, fontSize: 13 };
  return (
    <div style={{ fontSize: 13, maxWidth: 760 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{detail.name}</span>
        <span
          style={{
            fontSize: 10,
            padding: "0 5px",
            borderRadius: 8,
            color: "#fff",
            background: KIND_COLOR[detail.kind] ?? "#6b7280",
          }}
        >
          {detail.kind}
        </span>
        {detail.version && (
          <span style={{ color: "#6b7280" }}>v{detail.version}</span>
        )}
      </div>
      {detail.description && (
        <div style={{ marginTop: 6, color: "#374151" }}>{detail.description}</div>
      )}
      <div style={{ ...section, fontSize: 12, color: "#6b7280", ...monoStyle, wordBreak: "break-all" }}>
        {detail.path}
      </div>
      {detail.submodules.length > 0 && (
        <div style={section}>
          <div style={label}>子模块</div>
          <div>{detail.submodules.join("、")}</div>
        </div>
      )}
      <div style={section}>
        <div style={label}>模板</div>
        {detail.templates.length ? (
          <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
            {detail.templates.map((t) => (
              <li key={t}>
                {t}
                {t === detail.default_template && (
                  <span style={{ color: "#16a34a" }}>（默认）</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ color: "#9ca3af" }}>（无模板——模块自带流程定义）</div>
        )}
      </div>
      {detail.spec_schema && (
        <div style={section}>
          <div style={label}>spec 字段</div>
          <table style={{ borderCollapse: "collapse", marginTop: 4 }}>
            <tbody>
              {Object.entries(detail.spec_schema).map(([k, t]) => (
                <tr key={k}>
                  <td style={{ border: "1px solid #e5e7eb", padding: "2px 10px", ...monoStyle }}>
                    {k}
                  </td>
                  <td style={{ border: "1px solid #e5e7eb", padding: "2px 10px", color: "#6b7280" }}>
                    {t}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={section}>
        <div style={label}>default_spec</div>
        <pre
          style={{
            ...monoStyle,
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: 8,
            fontSize: 12,
            overflowX: "auto",
          }}
        >
          {detail.default_spec != null
            ? JSON.stringify(detail.default_spec, null, 2)
            : "（无——运行时留空 spec 将使用模板缺省）"}
        </pre>
      </div>
    </div>
  );
}
