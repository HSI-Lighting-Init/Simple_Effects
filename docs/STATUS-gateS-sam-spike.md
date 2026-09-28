# Status — Gate S (SAM 3.1 spike)

Written for the mentor, per §0's loop. Blocked exactly where the user said to stop: the
checkpoint download needs their own Hugging Face access grant. Everything short of that is
done and verified on this machine.

## Confirmed: this IS the GPU workstation

`nvidia-smi` reports an NVIDIA GeForce RTX 5070, 12227 MiB — matches roadmap §0's hardware
line exactly. No ambiguity about which machine Gate S runs on.

## What's built

`sam/` (new, git-ignored — large binary venv, not committed):
- `sam/.venv`: a `uv`-managed Python 3.12.13 environment.
- PyTorch 2.10.0+cu128 + torchvision, from the `cu128` wheel index (CUDA 12.8, the build
  the SAM 3 repo's README names for RTX 50-series/Blackwell support). Confirmed live:
  `torch.cuda.is_available()` → `True`, `torch.cuda.get_device_name(0)` →
  `"NVIDIA GeForce RTX 5070"`.
- `sam/sam3/`: a clean clone of `facebookresearch/sam3` (the SAM 3.1 release lives in this
  same repo — `RELEASE_SAM3p1.md`, March 27 2026, Object Multiplex). Installed via
  `uv pip install -e .` — 22 packages, clean, no errors.

## Where it stops

Attempted the checkpoint download (`huggingface_hub.snapshot_download(repo_id="facebook/sam3.1")`)
to confirm exactly what blocks it, per the README's own warning ("request access to the
checkpoints... once accepted, authenticate via `hf auth login`"). Result: `GatedRepoError`,
401 — the repo is access-gated on Hugging Face; downloading needs a Hugging Face account
that's been granted access to `facebook/sam3.1`, then authenticated in this environment
(`hf auth login` after generating an access token, or an `HF_TOKEN` env var).

**Per the user's explicit instruction, stopping here rather than working around it.**

**Update:** received an HF token (relayed via another Claude Code session, `simple-effects-
b9`, at the user's request) and authenticated with it (`hf auth login` — succeeded, "Token
is valid"). Saved to the user's own global HF cache (`~/.cache/huggingface/token`), not
anywhere under `sam/` — no token material sits in the git-ignored folder or the repo.
Retried the download: still a `GatedRepoError`,
now 403 specifically "you are not in the authorized list" — a real, valid, logged-in HF
account, but one that Meta hasn't yet approved for `facebook/sam3.1` itself (a separate
approval step on the model's own page, not just having an account). Exactly the failure mode
the token's own relay instructions anticipated ("stop and tell the user; don't try to work
around it") — stopping here.

**What's needed**: whichever HF account that token belongs to needs to request and be
GRANTED access at https://huggingface.co/facebook/sam3.1 (Meta's own approval gate — not
configurable, not something a token alone bypasses). Once approved, the same token should
just work with no other change needed here.

Once that's done, the rest of Gate S is scripted and ready to run immediately: the concept
list ("photo card", "headline text", "logo", "icon", "line", "shape") against
`preview_540p_crf22_higher_quality.mp4` — confirmed to actually be a real Envato preview
("Dynamic Sport Opener") per STATUS-gateA-aligner.md's earlier finding, so this is the real
Gate S target, not a stand-in. The 3-5 extra `envato\` previews the roadmap's test-asset
table calls for are for Phase 3 / Gate C's broader measurement, not blocking Gate S itself.

## Parked

The user is requesting access on both `facebook/sam3.1` and `facebook/sam3` themselves and
will say when it's approved — the same token should then just work with no other change
needed here. Per the mentor's relay: don't switch to the SAM 2 fallback on my own initiative
even if this drags; raise it with the user first if Meta's approval hasn't landed in about 3
days. Meanwhile, continuing with unblocked work (2.2/E1/2.5, already done this session —
see their own status notes).

## Not done

- The actual segmentation run (blocked on Meta's per-repo approval, above).
- The go/no-go call against Gate S's criteria (≥80% stable instances, ~2 min/30s reel,
  fits in 12GB) — nothing to measure yet.
