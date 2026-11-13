# Auto-update: design

Date: 2026-11-04 · Status: waiting for review · Branch: `feature/timeline-trim-comp-duration`

## Goal

Simple Effects finds out when a newer build is published to
[HSI-Lighting/release](https://github.com/HSI-Lighting/release), asks the user,
and installs it and reopens itself without anyone handing around installers.

Already decided:

- The app checks on launch and from **Help → Check for updates…**. If a newer build exists it asks first.
  If the user says yes, it saves the user's work, downloads, installs silently and restarts.
- `npm run deploy -- -Publish` builds and publishes, using the github.com login git already has on the PC
  (or `GITHUB_TOKEN` if set). That account needs write access to HSI-Lighting/release.
- Release names follow the other HSI apps: tag `simple-effects-v0.1.<build>`, asset
  `simple-effects_0.1.<build>_windows.exe`. `0.1` is `major.minor` from `package.json`, and `<build>` is the
  `build.json` number that deploy.ps1 already increments.

## Why a manifest file instead of the GitHub API

GitHub allows 60 unauthenticated API calls per hour **per IP**. The office IP has already run out
(`403 rate limit exceeded`), probably because the other HSI apps poll the same API. An update check that
uses the API would fail on most launches.

Release *downloads* (`github.com/<owner>/<repo>/releases/download/<tag>/<file>`) don't count against that
limit. So each publish also updates one small file at a fixed download URL:

```
https://github.com/HSI-Lighting/release/releases/download/simple-effects-latest/latest.json
```

```json
{
  "build": 72,
  "version": "0.1.72",
  "url": "https://github.com/HSI-Lighting/release/releases/download/simple-effects-v0.1.72/simple-effects_0.1.72_windows.exe",
  "size": 18734512,
  "sha256": "9f2c…",
  "date": "2026-11-05"
}
```

`simple-effects-latest` is a pre-release whose only asset is `latest.json`. It is a pre-release, and both
releases are created with `make_latest: false`, so Simple Effects never takes the repo's "Latest" badge from
another app.

## Publishing (deploy.ps1 `-Publish`)

`npm run deploy` behaves as it does today. With `-Publish`:

1. **Before building**, the script gets a GitHub login: `GITHUB_TOKEN` if set, else git's stored github.com
   login (`git credential fill`, no prompts). It stops if there is none, so a build isn't wasted.
2. Build and install locally as today.
3. Compute the installer's size and SHA-256 (`Get-FileHash`).
4. Create release `simple-effects-v0.1.<build>` (`make_latest: false`, body = build date and commit). Upload
   the NSIS installer to it as `simple-effects_0.1.<build>_windows.exe`.
5. Get or create the `simple-effects-latest` pre-release. Delete its old `latest.json` and upload the new one.

The installer goes up before the manifest, so the app never sees a manifest that points at a missing file.
All calls use `Invoke-RestMethod` against the GitHub REST API (the `gh` CLI isn't installed here). If any
call fails, the script stops and prints GitHub's message.

The login is only used in the API calls' Authorization header. It is never printed or written to a
file.

If publishing fails after the build, running deploy again makes the next build number. That costs one
skipped number and nothing else.

## Checking (app)

**Rust**, in `lib.rs`, with no new HTTP dependency:

- `fetch_update_manifest() -> Result<UpdateManifest, String>` downloads `latest.json` with Windows' own
  `curl.exe` (`-fsSL --max-time 15`, run through `quiet_command`, so no console window flashes) and parses it
  with serde.

**Frontend**, in a new `src/lib/update.ts`:

- `isNewer(manifest, BUILD_INFO)` returns true when `manifest.build > BUILD_INFO.build`.
- **On launch**, in release builds only (`!import.meta.env.DEV`), the app checks once 5 s after start. Any
  failure (offline, GitHub down, bad JSON) is only logged, because a launch should never show an error about
  updates. If a newer build exists, it asks:
  *"Simple Effects build 72 is available (you have 71). Install it now?"* with **Install** and **Later**.
  **Later** means it doesn't ask again until the next launch.
- **Help → Check for updates…** runs the same check, but always answers. Either it asks the same question,
  or it says *"You're on the latest build (71)."*, or it shows
  *"Couldn't check for updates: <reason>."* In a dev build it says that updates are off in dev builds.

## Installing

When the user clicks **Install**:

1. If an export or merge is running, the app says *"Finish or cancel the export first."* and stops.
2. If the project has unsaved changes, the app runs the normal Save (`doSave`). Cancelling the Save dialog
   cancels the update.
3. A busy card (same style as the export card) shows *"Downloading update…"* while Rust's
   `install_update(manifest)` runs:
   - It refuses any `url` that doesn't start with
     `https://github.com/HSI-Lighting/release/releases/download/`.
   - It downloads with `curl.exe -fL` to `%TEMP%\simple-effects-update-<build>.exe`.
   - It checks the size and SHA-256 against the manifest. `sha2` is already in `Cargo.lock` through Tauri, so
     it becomes a direct dependency without adding any new code to the build. On a mismatch, the file is
     deleted and the update fails.
   - It starts a hidden, detached helper:
     `powershell -WindowStyle Hidden -Command "Wait-Process -Id <app pid>; Start-Process -Wait <installer> -ArgumentList /S; Start-Process <current exe>"`
   - It exits the app.
4. The helper waits for the app to close, so its exe is no longer locked. It then runs the installer silently
   (the same `/S` install deploy.ps1 uses) and reopens the app, which is now the new build.

If anything fails before the app exits, the user gets an alert with the reason and keeps working in the old
build.

## Security

Anyone who can publish to HSI-Lighting/release, or who holds that token, can push code that runs on every
PC with Simple Effects. That is the same trust the team already places in shared installers, but now nobody
has to click anything. The SHA-256 catches corrupted or cut-off downloads, not a malicious publisher. The
upgrade path is signed updates (the Tauri updater plugin with its own signing key, or an Authenticode code
signing certificate). That is not part of this change, which matches how the other HSI apps ship.

## Testing

- **vitest**: `isNewer` with newer, same and older builds.
- **Rust unit tests**:
  - The download check: size mismatch, hash mismatch and a match, using a temp file.
  - The URL allow-list.
  - Parsing a sample `latest.json`.
- **End to end**, which needs the token, ideally done together:
  1. Publish build N and install it.
  2. Publish build N+1.
  3. Open build N. It should ask, install, and reopen as N+1.
  4. In N+1, **Help → Check for updates…** should say it is up to date.

## Not included (add when needed)

- Downloading in the background before asking, a progress percentage, release notes in the prompt,
  "skip this version", and rollback.
- Signed updates (see Security).
- macOS.
