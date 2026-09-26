// "Scenario → Video": pick assets, write a scenario, and let the agent build the
// timeline via the tool registry. BYO key (localStorage, never in the repo).
// Edits land on the live timeline; on finish the project is saved to the Desktop
// so the work can't be lost. Cancel aborts the loop.
import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentCtx, MediaAsset } from "../agent/tools";
import { runAgent } from "../agent/orchestrator";
import { MODELS, type ProviderId } from "../agent/providers";
import { STYLE_PACKS } from "../lib/stylePacks";

const IMPORT_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "mov", "webm", "mkv", "m4v", "mp3", "wav", "m4a", "aac", "ogg"];

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "error"; text: string };

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  running: { bg: "rgba(91,140,255,0.18)", fg: "#9db8ff" },
  done: { bg: "rgba(46,204,113,0.16)", fg: "#7ee2a8" },
  warn: { bg: "rgba(241,196,15,0.16)", fg: "#f1d77a" },
  error: { bg: "rgba(231,76,60,0.16)", fg: "#ff9b8f" },
};

export default function ScenarioPanel({
  buildCtx,
  probe,
  mediaPaths,
  onSaveToDesktop,
  onDone,
  onClose,
}: {
  buildCtx: (media: MediaAsset[]) => AgentCtx;
  probe: (path: string) => Promise<MediaAsset>;
  mediaPaths: string[];
  onSaveToDesktop: () => Promise<string>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<string[]>(() => [...mediaPaths]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(mediaPaths));
  const [scenario, setScenario] = useState("");
  const [targetSec, setTargetSec] = useState(20);
  const [style, setStyle] = useState("auto"); // a style pack id, or "auto"
  const [provider, setProvider] = useState<ProviderId>(() => (localStorage.getItem("sefx.provider") as ProviderId) || "anthropic");
  const [model, setModel] = useState(() => localStorage.getItem(`sefx.model.${provider}`) || MODELS[provider].models[0]);
  const [keys, setKeys] = useState<Record<ProviderId, string>>(() => ({
    anthropic: localStorage.getItem("sefx.key.anthropic") || "",
    deepseek: localStorage.getItem("sefx.key.deepseek") || "",
  }));
  const apiKey = keys[provider];
  const [dryRun, setDryRun] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const running = status.kind === "running";

  const addLog = (t: string) => setLog((l) => [...l, t]);
  const pickProvider = (p: ProviderId) => {
    setProvider(p);
    setModel(localStorage.getItem(`sefx.model.${p}`) || MODELS[p].models[0]);
  };
  const toggle = (p: string) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const pickFiles = async () => {
    const sel = await open({ multiple: true, filters: [{ name: "Media", extensions: IMPORT_EXTS }] });
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    if (!paths.length) return;
    setAssets((a) => [...new Set([...a, ...paths])]);
    setPicked((s) => new Set([...s, ...paths]));
  };

  const saveToDesktop = async () => {
    try {
      const path = await onSaveToDesktop();
      addLog(`💾 Saved to ${path}`);
      return path;
    } catch (e) {
      addLog("⚠ Save failed: " + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  const run = async () => {
    if (!apiKey.trim()) return addLog(`⚠ Enter your ${MODELS[provider].label} API key first.`);
    if (!scenario.trim()) return addLog("⚠ Write a scenario first.");
    const chosen = assets.filter((p) => picked.has(p));
    if (!chosen.length) return addLog("⚠ Select at least one asset.");
    localStorage.setItem("sefx.provider", provider);
    localStorage.setItem(`sefx.model.${provider}`, model.trim());
    localStorage.setItem(`sefx.key.${provider}`, apiKey.trim());
    setStatus({ kind: "running" });
    setLog([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      addLog(`Probing ${chosen.length} asset(s)…`);
      const media = await Promise.all(chosen.map(probe));
      const ctx = buildCtx(media);
      addLog(dryRun ? "Planning (dry run)…" : "Editing…");
      const { summary, edits } = await runAgent(ctx, {
        provider,
        apiKey: apiKey.trim(),
        model: model.trim(),
        scenario,
        targetSec,
        style,
        dryRun,
        signal: ac.signal,
        onLog: addLog,
      });
      addLog("Model: " + summary);
      if (dryRun) {
        setStatus({ kind: "done", text: "Plan ready (dry run — nothing changed)." });
      } else if (edits === 0) {
        setStatus({ kind: "warn", text: "Finished, but the model made no edits. Try again, or switch to Claude." });
      } else {
        const path = await saveToDesktop();
        setStatus({ kind: "done", text: `Finished — ${edits} edit${edits === 1 ? "" : "s"}.${path ? " Saved to Desktop." : ""}` });
        onDone();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If it was cancelled mid-edit, still offer to keep what landed.
      if (/cancel/i.test(msg)) {
        await saveToDesktop();
        setStatus({ kind: "warn", text: "Cancelled — progress so far was saved to the Desktop." });
      } else {
        setStatus({ kind: "error", text: msg });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 };

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && onClose()}>
      <div className="modal-box scenario-panel" style={{ width: 580, maxWidth: "94vw", maxHeight: "92vh", overflowY: "auto" }} onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Scenario → Video (AI)</h3>

        <div className="insp-sep">Assets</div>
        <div style={{ maxHeight: 116, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 4, padding: 6 }}>
          {assets.length === 0 && <div className="insp-hint">No media yet — add files.</div>}
          {assets.map((p) => (
            <label key={p} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(p)} onChange={() => toggle(p)} disabled={running} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.split(/[\\/]/).pop()}</span>
            </label>
          ))}
        </div>
        <button className="insp-btn" onClick={pickFiles} disabled={running} style={{ marginTop: 6 }}>＋ Add files…</button>

        <div className="insp-sep">Scenario</div>
        <textarea
          style={{ width: "100%", boxSizing: "border-box", minHeight: 64, resize: "vertical" }}
          placeholder="e.g. A 20s upbeat Instagram edit: fast cuts between the four clips on the beat, a short punchy title over the first, music underneath fading out at the end."
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          disabled={running}
        />
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <label style={field}>
            <span className="muted" style={{ fontSize: 11 }}>Target (s)</span>
            <input type="number" min={3} max={600} value={targetSec} onChange={(e) => setTargetSec(Number(e.target.value))} disabled={running} />
          </label>
          <label style={field}>
            <span className="muted" style={{ fontSize: 11 }}>Style pack</span>
            <select value={style} onChange={(e) => setStyle(e.target.value)} disabled={running}>
              <option value="auto">Auto — match the scenario</option>
              {STYLE_PACKS.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.category})</option>
              ))}
            </select>
          </label>
        </div>

        <div className="insp-sep">Provider (your key, stored locally)</div>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={field}>
            <span className="muted" style={{ fontSize: 11 }}>Provider</span>
            <select value={provider} onChange={(e) => pickProvider(e.target.value as ProviderId)} disabled={running}>
              {(Object.keys(MODELS) as ProviderId[]).map((p) => (
                <option key={p} value={p}>{MODELS[p].label}</option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span className="muted" style={{ fontSize: 11 }}>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
              {[...new Set([model, ...MODELS[provider].models])].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        <label style={{ ...field, marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 11 }}>API key</span>
          <input type="password" value={apiKey} onChange={(e) => setKeys((k) => ({ ...k, [provider]: e.target.value }))} disabled={running} placeholder={provider === "deepseek" ? "sk-…" : "sk-ant-…"} />
        </label>
        {provider === "deepseek" && <p className="insp-hint" style={{ marginTop: 4 }}>DeepSeek is text-only — it can't see preview frames, so it verifies from timeline metadata.</p>}
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
          Dry run (plan only, don't change the project)
        </label>

        {status.kind !== "idle" && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              borderRadius: 4,
              fontSize: 13,
              background: STATUS_STYLE[status.kind]?.bg,
              color: STATUS_STYLE[status.kind]?.fg,
            }}
          >
            {running ? "⏳ Working… you can Cancel to stop." : status.kind === "done" ? "✓ " + status.text : (status.kind === "warn" ? "⚠ " : "✕ ") + status.text}
          </div>
        )}

        {log.length > 0 && (
          <>
            <div className="insp-sep">Activity</div>
            <div style={{ maxHeight: 150, overflowY: "auto", fontSize: 12, lineHeight: 1.5, fontFamily: "ui-monospace, monospace", background: "rgba(0,0,0,0.28)", borderRadius: 4, padding: 8, whiteSpace: "pre-wrap" }}>
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button className="insp-btn" onClick={onClose} disabled={running}>Close</button>
          <button className="insp-btn" onClick={saveToDesktop} disabled={running} title="Save the current project to the Desktop">💾 Save to Desktop</button>
          {running ? (
            <button className="insp-btn modal-danger" onClick={cancel}>Cancel</button>
          ) : (
            <button className="insp-btn active" onClick={run}>{dryRun ? "Plan" : "Build video"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
