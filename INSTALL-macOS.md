# Installing Simple Effects on macOS

Simple Effects is a Tauri (Rust + web) desktop app. The Windows installers on the
Desktop **only work on Windows** — a macOS build has to be produced *on a Mac*
(Tauri can't cross‑compile Windows → macOS). This guide covers both cases:

- **[A. Build & install from source](#a-build--install-from-source)** — the normal
  path on a Mac (you have the code, no prebuilt Mac app yet).
- **[B. Install a prebuilt `.dmg` / `.app`](#b-install-a-prebuilt-dmg--app)** — if
  someone hands you a Mac build made on another Mac.

Works on both **Apple Silicon (M1–M4)** and **Intel** Macs.

---

## A. Build & install from source

### 1. Install the prerequisites

Open **Terminal** (⌘‑Space → "Terminal") and run each block.

**Xcode Command Line Tools** (C compiler + macOS SDK Tauri needs):
```bash
xcode-select --install
```
A dialog pops up — click **Install** and wait for it to finish. (If it says
"already installed", you're good.)

**Homebrew** (package manager — skip if you already have `brew`):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
After it finishes, follow the "Next steps" it prints to add `brew` to your PATH
(on Apple Silicon it's usually `eval "$(/opt/homebrew/bin/brew shellenv)"`).

**Node.js (v20+), Rust, and ffmpeg:**
```bash
brew install node rust ffmpeg
```
- `node` — builds the web UI.
- `rust` — compiles the app backend (gives you `cargo`).
- `ffmpeg` — required for **MP4 export** and for muxing audio into exports.
  (WebM export works without it. On Windows the app can auto‑install ffmpeg; on
  macOS install it here with Homebrew.)

> Prefer the official Rust installer? You can instead run
> `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` and restart
> the terminal. Either way you need `cargo` on your PATH.

**Verify the toolchain:**
```bash
node --version    # v20 or newer
cargo --version   # any 1.7x+
ffmpeg -version   # prints version info
```

### 2. Get the code

If you have the project folder already, `cd` into it. Otherwise clone it:
```bash
git clone https://github.com/HSI-Lighting-Init/Simple_Effects.git
cd Simple_Effects
```

### 3. Install JS dependencies
```bash
npm install
```

### 4. Run it (development)

To just use the app immediately, without packaging:
```bash
npm run tauri dev
```
The first run compiles the Rust backend (a few minutes); after that it's fast.
The app window opens automatically. Leave the terminal open while using it.

### 5. Build an installable `.app` / `.dmg` (optional)

To produce a real double‑clickable app you can keep in **Applications**:
```bash
npm run tauri build
```
When it finishes, the outputs are under:
```
src-tauri/target/release/bundle/
├── macos/Simple Effects.app     ← the app bundle
└── dmg/Simple Effects_0.1.0_<arch>.dmg   ← drag‑to‑install disk image
```
- `<arch>` is `aarch64` on Apple Silicon or `x64` on Intel.
- Double‑click the `.dmg`, then drag **Simple Effects** into **Applications**.
- Or just move the `.app` straight into `/Applications`.

Because this build is **unsigned**, the first launch needs the one‑time Gatekeeper
step in [section B.2](#2-first-launch-bypass-gatekeeper-unsigned-app).

---

## B. Install a prebuilt `.dmg` / `.app`

### 1. Install

- **`.dmg`:** double‑click it, then drag **Simple Effects** onto the
  **Applications** shortcut in the window that appears. Eject the disk image
  afterwards.
- **`.app`:** drag it into `/Applications`.

### 2. First launch (bypass Gatekeeper — unsigned app)

The app isn't notarized by Apple, so the first time you open it macOS blocks it
("**Simple Effects can't be opened because Apple cannot check it for malicious
software**", or "**is damaged**"). This is expected for an in‑house app. Do this
**once**:

**Easiest — right‑click open:**
1. In **Applications**, **right‑click** (or Control‑click) **Simple Effects**.
2. Choose **Open**.
3. In the dialog, click **Open** again.

After that it launches normally every time.

**If that dialog has no "Open" button** (newer macOS), go to
**System Settings → Privacy & Security**, scroll to the Security section, and
click **"Open Anyway"** next to the Simple Effects message, then confirm.

**If macOS says the app is "damaged"** (happens when a `.dmg`/`.app` is downloaded
via a browser and quarantined), clear the quarantine flag in Terminal:
```bash
xattr -dr com.apple.quarantine "/Applications/Simple Effects.app"
```
Then open it normally.

---

## Notes & troubleshooting

- **MP4 export fails / "ffmpeg not found":** install it with `brew install ffmpeg`,
  then restart the app. WebM export does not need ffmpeg.
- **`xcrun: error: invalid active developer path`** during build: re‑run
  `xcode-select --install`.
- **`cargo: command not found`:** your Rust PATH isn't set — open a new terminal,
  or run `source "$HOME/.cargo/env"` (rustup) / `eval "$(brew shellenv)"` (brew).
- **Build is slow the first time:** normal — Rust compiles all dependencies once,
  then caches them. Subsequent builds are much faster.
- **App identifier:** `com.hsilighting.simpleeffects` (useful if you need to find
  or reset its settings/permissions).
