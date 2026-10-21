// Phase 7: "drop a video, get a template." Picks a reference video + new
// media, runs the full autonomous extraction (templateExtractor.ts), and
// hands the finished project back to the parent (same onCreate-returns-a-
// Project convention every other template dialog here already uses).
//
// Still effectively dev-only in practice, even though it no longer needs an
// external MCP agent the way extraction.ts's own dev tools do: sam_service.py
// needs a local Python venv with SAM3/SAM2's model weights already
// downloaded (see sam/README-equivalent context in docs/STATUS-phase3-core.md)
// - nothing in this app bundles or installs that for a real end user yet.
// The python/script path fields below exist because of that gap, not by
// design - a genuinely shippable version would need the service bundled
// with the app and these fields gone entirely.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { startSamService } from "../lib/api";
import { extractTemplate } from "../lib/templateExtractor";
import type { RebuildIO, RebuildResult } from "../lib/rebuildFromAnalysis";
import { MODELS } from "../agent/providers";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function TemplateExtractorDialog({
  buildIO,
  onExtracted,
  onClose,
}: {
  buildIO: () => RebuildIO;
  onExtracted: (result: RebuildResult) => void | Promise<void>;
  onClose: () => void;
}) {
  const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
  const [newMedia, setNewMedia] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("sefx.key.anthropic") || "");
  const [model, setModel] = useState(() => localStorage.getItem("sefx.model.anthropic") || MODELS.anthropic.models[1]);
  const [pythonPath, setPythonPath] = useState(() => localStorage.getItem("sefx.samPythonPath") || "");
  const [scriptPath, setScriptPath] = useState(() => localStorage.getItem("sefx.samScriptPath") || "");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const addLog = (line: string) => setLog((l) => [...l, line]);

  const pickReference = async () => {
    const sel = await open({ multiple: false, filters: [{ name: "Video", extensions: ["mp4", "mov", "webm", "mkv"] }] });
    if (typeof sel === "string") setReferenceVideo(sel);
  };
  const addNewMedia = async () => {
    const sel = await open({ multiple: true, filters: [{ name: "Images/Video", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "mp4", "mov", "webm"] }] });
    if (!sel) return;
    setNewMedia((prev) => [...prev, ...(Array.isArray(sel) ? sel : [sel])]);
  };
  const removeAt = (i: number) => setNewMedia((prev) => prev.filter((_, j) => j !== i));

  const canStart = !!referenceVideo && newMedia.length > 0 && !!apiKey.trim() && !!pythonPath.trim() && !!scriptPath.trim() && !busy;

  const start = async () => {
    if (!referenceVideo) return;
    localStorage.setItem("sefx.key.anthropic", apiKey.trim());
    localStorage.setItem("sefx.model.anthropic", model.trim());
    localStorage.setItem("sefx.samPythonPath", pythonPath.trim());
    localStorage.setItem("sefx.samScriptPath", scriptPath.trim());
    setBusy(true);
    setLog([]);
    try {
      addLog("Starting SAM service (first run loads models, ~10s)...");
      await startSamService(pythonPath.trim(), scriptPath.trim(), 8799);
      const deadline = Date.now() + 90_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch("http://127.0.0.1:8799/health");
          if (res.ok) { healthy = true; break; }
        } catch {
          // not listening yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!healthy) throw new Error("sam_service did not become healthy within 90s - check the python/script paths");
      addLog("SAM service ready.");

      const workDir = await join(await appLocalDataDir(), "template_extractor_scratch");
      const outPath = await join(await appLocalDataDir(), "template_extractor_scratch", "extracted.mp4");
      const result = await extractTemplate(buildIO(), {
        referenceVideoPath: referenceVideo,
        newMedia,
        outPath,
        apiKey: apiKey.trim(),
        model: model.trim(),
        workDir,
        onProgress: addLog,
      });
      addLog("Done.");
      await onExtracted(result);
      onClose();
    } catch (e) {
      addLog(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div className="modal" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Extract template from video</div>
        <div className="modal-body">
          <p className="insp-hint">
            Drop a reference video in — the app measures its cuts, cards, logos and text, then rebuilds the same structure with your own media.
            Dev-only for now: needs a local SAM3/SAM2 service (see pythonPath/scriptPath below).
          </p>

          <div className="insp-field">
            <div className="row2">
              <button className="insp-btn" onClick={pickReference} disabled={busy}>
                {referenceVideo ? "Change reference video…" : "Pick reference video…"}
              </button>
              {referenceVideo && <span className="muted" title={referenceVideo}>{baseName(referenceVideo)}</span>}
            </div>
          </div>

          <div className="insp-field">
            <div className="row2">
              <button className="insp-btn" onClick={addNewMedia} disabled={busy}>＋ Add your own media…</button>
              <span className="muted" style={{ alignSelf: "center" }}>{newMedia.length} item{newMedia.length === 1 ? "" : "s"}</span>
            </div>
            {newMedia.length > 0 && (
              <div className="tmpl-list">
                {newMedia.map((p, i) => (
                  <div className="tmpl-row" key={`${p}-${i}`}>
                    <span className="tmpl-idx">{i + 1}</span>
                    <span className="tmpl-name" title={p}>{baseName(p)}</span>
                    <button className="tmpl-mini" title="Remove" onClick={() => removeAt(i)} disabled={busy}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <label className="insp-field">
            <span className="muted" style={{ fontSize: 11 }}>Anthropic API key (for reading phrasings/text from frames)</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} placeholder="sk-ant-…" />
          </label>
          <label className="insp-field">
            <span className="muted" style={{ fontSize: 11 }}>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {MODELS.anthropic.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="insp-field">
            <span className="muted" style={{ fontSize: 11 }}>SAM service python.exe path (dev-only — e.g. .../sam/.venv/Scripts/python.exe)</span>
            <input type="text" value={pythonPath} onChange={(e) => setPythonPath(e.target.value)} disabled={busy} />
          </label>
          <label className="insp-field">
            <span className="muted" style={{ fontSize: 11 }}>sam_service.py path (dev-only)</span>
            <input type="text" value={scriptPath} onChange={(e) => setScriptPath(e.target.value)} disabled={busy} />
          </label>

          {log.length > 0 && (
            <div style={{ maxHeight: 150, overflowY: "auto", fontSize: 12, lineHeight: 1.5, fontFamily: "ui-monospace, monospace", background: "rgba(0,0,0,0.28)", borderRadius: 4, padding: 8, whiteSpace: "pre-wrap" }}>
              {log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}

          <div className="row2" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <button className="insp-btn" onClick={onClose} disabled={busy}>Close</button>
            <button className="insp-btn active" onClick={start} disabled={!canStart}>{busy ? "Extracting…" : "Start extraction"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
