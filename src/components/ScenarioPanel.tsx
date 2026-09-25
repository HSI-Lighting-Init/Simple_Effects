// "Scenario → Video": pick assets, write a scenario, and let the Claude agent
// build the timeline via the tool registry. BYO Anthropic key (kept in
// localStorage, never in the repo). Everything the agent does lands on the real
// timeline live; Cancel aborts the loop.
import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentCtx, MediaAsset } from "../agent/tools";
import { runAgent } from "../agent/orchestrator";
import { MODELS, type ProviderId } from "../agent/providers";
const IMPORT_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "mov", "webm", "mkv", "m4v", "mp3", "wav", "m4a", "aac", "ogg"];

export default function ScenarioPanel({
  buildCtx,
  probe,
  mediaPaths,
  onDone,
  onClose,
}: {
  buildCtx: (media: MediaAsset[]) => AgentCtx;
  probe: (path: string) => Promise<MediaAsset>;
  mediaPaths: string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<string[]>(() => [...mediaPaths]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(mediaPaths));
  const [scenario, setScenario] = useState("");
  const [targetSec, setTargetSec] = useState(20);
  const [style, setStyle] = useState("clean");
  const [provider, setProvider] = useState<ProviderId>(() => (localStorage.getItem("sefx.provider") as ProviderId) || "anthropic");
  const [model, setModel] = useState(() => localStorage.getItem(`sefx.model.${provider}`) || MODELS[provider].models[0]);
  const [keys, setKeys] = useState<Record<ProviderId, string>>(() => ({
    anthropic: localStorage.getItem("sefx.key.anthropic") || "",
    deepseek: localStorage.getItem("sefx.key.deepseek") || "",
  }));
  const apiKey = keys[provider];
  const pickProvider = (p: ProviderId) => {
    setProvider(p);
    setModel(localStorage.getItem(`sefx.model.${p}`) || MODELS[p].models[0]);
  };
  const [dryRun, setDryRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const addLog = (t: string) => setLog((l) => [...l, t]);
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

  const run = async () => {
    if (!apiKey.trim()) return addLog(`⚠ Enter your ${MODELS[provider].label} API key first.`);
    if (!scenario.trim()) return addLog("⚠ Write a scenario first.");
    const chosen = assets.filter((p) => picked.has(p));
    if (!chosen.length) return addLog("⚠ Select at least one asset.");
    localStorage.setItem("sefx.provider", provider);
    localStorage.setItem(`sefx.model.${provider}`, model.trim());
    localStorage.setItem(`sefx.key.${provider}`, apiKey.trim());
    setRunning(true);
    setLog([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      addLog(`Probing ${chosen.length} asset(s)…`);
      const media = await Promise.all(chosen.map(probe));
      const ctx = buildCtx(media);
      addLog(dryRun ? "Planning (dry run)…" : "Editing…");
      const { summary } = await runAgent(ctx, {
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
      addLog("✓ " + summary);
      if (!dryRun) onDone();
    } catch (e) {
      addLog("�— " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && onClose()}>
      <div className="modal-box" style={{ width: 560, maxWidth: "92vw" }} onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Scenario → Video (AI)</h3>

        <div className="insp-sep">Assets</div>
        <div style={{ maxHeight: 120, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 4, padding: 6 }}>
          {assets.length === 0 && <div className="insp-hint">No media yet — add files.</div>}
          {assets.map((p) => (
            <label key={p} className="ts-check" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={picked.has(p)} onChange={() => toggle(p)} disabled={running} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.split(/[\\/]/).pop()}</span>
            </label>
          ))}
        </div>
        <button className="insp-btn" onClick={pickFiles} disabled={running} style={{ marginTop: 6 }}>＋ Add files…</button>

        <div className="insp-sep">Scenario</div>
        <textarea
          className="insp-num"
          style={{ width: "100%", minHeight: 70, resize: "vertical" }}
          placeholder="e.g. A 20-second upbeat intro: open on the city clip, cut to the three product photos with a title on each, end on the logo. Add the music track under it, fading out."
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          disabled={running}
        />
        <div className="row2" style={{ gap: 8, marginTop: 6 }}>
          <label className="insp-field" style={{ flex: 1 }}>
            Target (s)
            <input type="number" min={3} max={600} value={targetSec} onChange={(e) => setTargetSec(Number(e.target.value))} disabled={running} />
          </label>
          <label className="insp-field" style={{ flex: 1 }}>
            Style
            <input value={style} onChange={(e) => setStyle(e.target.value)} disabled={running} />
          </label>
        </div>

        <div className="insp-sep">Provider (your key, stored locally)</div>
        <div className="row2" style={{ gap: 8 }}>
          <label className="insp-field" style={{ flex: 1 }}>
            Provider
            <select value={provider} onChange={(e) => pickProvider(e.target.value as ProviderId)} disabled={running}>
              {(Object.keys(MODELS) as ProviderId[]).map((p) => (
                <option key={p} value={p}>{MODELS[p].label}</option>
              ))}
            </select>
          </label>
          <label className="insp-field" style={{ flex: 1 }}>
            Model
            <input list="agent-models" value={model} onChange={(e) => setModel(e.target.value)} disabled={running} />
            <datalist id="agent-models">
              {MODELS[provider].models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        </div>
        <label className="insp-field" style={{ display: "block" }}>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setKeys((k) => ({ ...k, [provider]: e.target.value }))}
            disabled={running}
            placeholder={provider === "deepseek" ? "sk-…" : "sk-ant-…"}
          />
        </label>
        {provider === "deepseek" && (
          <p className="insp-hint">DeepSeek is text-only — it can't see preview frames, so it verifies from timeline metadata.</p>
        )}
        <label className="ts-check" style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={running} />
          Dry run (plan only, don't change the project)
        </label>

        {log.length > 0 && (
          <>
            <div className="insp-sep">Activity</div>
            <div style={{ maxHeight: 160, overflowY: "auto", fontSize: 12, fontFamily: "monospace", background: "rgba(0,0,0,0.25)", borderRadius: 4, padding: 8 }}>
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 10 }}>
          <button className="insp-btn" onClick={onClose} disabled={running}>
            Close
          </button>
          {running ? (
            <button className="insp-btn modal-danger" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button className="insp-btn active" onClick={run}>
              {dryRun ? "Plan" : "Build video"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
