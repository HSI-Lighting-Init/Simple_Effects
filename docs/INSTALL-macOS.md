# Installing Simple Effects on macOS

Simple Effects is a **Tauri** app. The Windows installer you already have
(`Simple Effects Setup.exe`) is Windows-only and will **not** run on a Mac.

There is currently **no prebuilt `.dmg` for macOS**, and you can't build one
from Windows — Tauri needs Apple's own toolchain (and the macOS WebView) to
produce a Mac app. So on macOS you **build it from source on the Mac itself**.
The good news: the code already compiles and runs on macOS (all the
Windows-only pieces are conditionally compiled out), so it's just a matter of
installing the toolchain and running one build command.

Two ways to run it, covered below:
- **A. Build a real `.app` / `.dmg`** you can keep in Applications (recommended).
- **B. Run it in dev mode** for a quick try without packaging.

---

## 0. What you'll need (one-time setup)

Do these on the Mac. Copy‑paste each block into **Terminal**
(Applications → Utilities → Terminal).

### 1) Xcode Command Line Tools (compiler + linker)
```bash
xcode-select --install
```
Click through the installer dialog if it appears. If it says
"already installed", you're good.

### 2) Homebrew (macOS package manager)
If you don't already have it:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
After it finishes, follow the on-screen "Next steps" it prints (it may ask you
to add a line to your shell profile so the `brew` command is found).

### 3) Node.js (LTS) — builds the front-end
```bash
brew install node
```

### 4) Rust — builds the app's backend
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
Accept the default install. Then either open a **new** Terminal window, or run:
```bash
source "$HOME/.cargo/env"
```

### 5) ffmpeg — needed for audio + video export
```bash
brew install ffmpeg
```
> **Important:** On Windows the app can auto-install ffmpeg for you (via winget).
> On macOS that auto-installer does **not** work, so you must install ffmpeg
> yourself with the command above. Without it, the preview still works, but
> **exporting audio/video will fail**. Homebrew puts `ffmpeg` on your PATH, which
> is exactly where the app looks for it — no extra configuration needed.

Verify the essentials are installed:
```bash
node -v && cargo --version && ffmpeg -version | head -1
```
You should see a version number from each.

---

## 1. Get the source code

**If you have access to the GitHub repo:**
```bash
cd ~/Downloads
git clone https://github.com/HSI-Lighting-Init/Simple_Effects.git
cd Simple_Effects
# The newest features live on this branch (not main):
git checkout feature/timeline-trim-comp-duration
```

**If you don't use git / were given the folder directly:**
Copy the whole `Simple_Effects` project folder onto the Mac (USB drive,
AirDrop, cloud, etc.), open Terminal, and `cd` into it, e.g.:
```bash
cd ~/Downloads/Simple_Effects
```

> Make sure you copy the **source project folder** (the one containing
> `package.json` and the `src-tauri` folder) — not the Windows `.exe`.

---

## 2. Option A — Build the app (recommended)

From inside the project folder:

```bash
# 1) install the front-end dependencies (first time only)
npm install

# 2) build the macOS app + installer
npm run tauri build
```

> Do **not** run `npm run deploy` on macOS — that script is the Windows-only
> packaging/installer step (it uses PowerShell). `npm run tauri build` is the
> cross-platform build.

The first build downloads and compiles the Rust dependencies, so it can take
**several minutes**. Subsequent builds are much faster.

When it finishes, your app is here:

```
src-tauri/target/release/bundle/macos/Simple Effects.app      ← the app
src-tauri/target/release/bundle/dmg/Simple Effects_0.1.0_*.dmg ← drag-to-install
```

- **To install:** open the `.dmg` and drag **Simple Effects** into your
  **Applications** folder (or just double-click the `.app` to run it in place).

### First launch — get past Gatekeeper (unsigned app)
The app isn't code-signed / notarized by Apple, so the **first** time you open
it macOS will warn "cannot be opened because the developer cannot be verified."
This is expected. To allow it:

- **Right-click** (or Control-click) **Simple Effects.app → Open**, then click
  **Open** in the dialog. You only need to do this once.

If macOS is stubborn (newer versions sometimes are), run this once to clear the
quarantine flag, then open normally:
```bash
xattr -dr com.apple.quarantine "/Applications/Simple Effects.app"
```

---

## 3. Option B — Just try it (dev mode, no packaging)

If you only want to see it run without producing an installer:

```bash
npm install          # first time only
npm run tauri dev
```

This launches the app in a development window. It's not installed anywhere —
close the window / press Ctrl-C in Terminal to stop it. Great for a quick look;
use Option A when you want a permanent app in Applications.

---

## 4. Apple Silicon vs Intel

`npm run tauri build` automatically builds for **the Mac you're building on**
(Apple Silicon → arm64, Intel → x86_64). Just build on the target machine and
you don't have to think about this. (Building a single app that runs on both —
a "universal" binary — is possible but not required; ignore it unless you
specifically need one installer for both chip types.)

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: cargo` | Open a new Terminal, or run `source "$HOME/.cargo/env"`. |
| `command not found: brew` | Finish Homebrew's "Next steps" (add it to your PATH), then reopen Terminal. |
| `xcrun: error: ... command line tools` | Run `xcode-select --install` and let it finish. |
| Build fails on the very first `npm install` | Make sure you're **inside** the project folder (the one with `package.json`). |
| App opens but **export produces no file / errors** | Install ffmpeg: `brew install ffmpeg`, then relaunch the app. |
| "cannot be opened, unidentified developer" | Right-click → Open (once), or run the `xattr -dr com.apple.quarantine` command above. |
| Export has **no audio** | Same as above — that's ffmpeg. Confirm with `ffmpeg -version`. |

---

## Why there's no ready-made Mac installer

Simple Effects stays tiny (~4 MB on Windows) because it uses the operating
system's built-in web engine instead of bundling one. On Windows that engine is
WebView2; on macOS it's WKWebView. Each platform's app therefore has to be
built with that platform's tools — which is why the Mac version is built on a
Mac rather than shipped from the Windows machine. Once built, the result is a
normal native `.app`.

---

*Product: **Simple Effects** v0.1.0 · identifier `com.hsilighting.simpleeffects`.
Questions or a build error you can't get past? Send the last ~20 lines of the
Terminal output and it's usually a quick fix.*
