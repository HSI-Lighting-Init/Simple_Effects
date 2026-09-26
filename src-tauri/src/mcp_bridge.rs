//! Localhost HTTP bridge so an external MCP client (Claude Desktop / VS Code, via
//! the stdio proxy in `mcp/`) can drive the running app. The socket lives here (a
//! WebView can't listen), but the tool registry + renderer live in the frontend —
//! so each call is forwarded to the frontend over a Tauri event and the frontend
//! answers through the `mcp_bridge_reply` command. GET /mcp/tools is served from
//! the manifest the frontend hands us; POST /mcp/call round-trips one tool call.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

struct Bridge {
    pending: Mutex<HashMap<u64, Sender<String>>>,
    counter: AtomicU64,
    manifest: Mutex<String>,
    started: AtomicBool,
}

fn bridge() -> &'static Bridge {
    static B: OnceLock<Bridge> = OnceLock::new();
    B.get_or_init(|| Bridge {
        pending: Mutex::new(HashMap::new()),
        counter: AtomicU64::new(1),
        manifest: Mutex::new("{\"tools\":[]}".into()),
        started: AtomicBool::new(false),
    })
}

/// Deliver a frontend tool result to the HTTP request that's blocked waiting.
pub fn reply(req_id: u64, result: String) {
    if let Some(tx) = bridge().pending.lock().unwrap().remove(&req_id) {
        let _ = tx.send(result);
    }
}

fn respond_json(req: tiny_http::Request, body: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_header(header));
}

/// Start the listener once (idempotent — later calls just refresh the manifest).
pub fn start(app: AppHandle, port: u16, manifest: String) -> Result<(), String> {
    *bridge().manifest.lock().unwrap() = manifest;
    if bridge().started.swap(true, Ordering::SeqCst) {
        return Ok(()); // already listening
    }
    let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| {
        bridge().started.store(false, Ordering::SeqCst);
        format!("couldn't bind 127.0.0.1:{port}: {e}")
    })?;
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let is_post = *req.method() == tiny_http::Method::Post;
            if !is_post && url.starts_with("/mcp/tools") {
                let body = bridge().manifest.lock().unwrap().clone();
                respond_json(req, &body);
            } else if is_post && url.starts_with("/mcp/call") {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                let val: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let args = val.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}));
                let req_id = bridge().counter.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = channel::<String>();
                bridge().pending.lock().unwrap().insert(req_id, tx);
                let _ = app.emit("mcp://call", serde_json::json!({ "reqId": req_id, "name": name, "args": args }));
                let reply = rx.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| {
                    bridge().pending.lock().unwrap().remove(&req_id);
                    "{\"content\":[{\"type\":\"text\",\"text\":\"tool timed out — is the app busy or minimised?\"}],\"isError\":true}".into()
                });
                respond_json(req, &reply);
            } else {
                let _ = req.respond(tiny_http::Response::empty(404));
            }
        }
    });
    Ok(())
}
