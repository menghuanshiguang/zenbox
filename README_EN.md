<div align="center">

# zenbox

**A standalone one-command opencode free-model relay** — OpenAI-compatible forwarding + LAN multi-device + terminal IP banner

[简体中文](README.md) | **English**

<img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="runtime deps" src="https://img.shields.io/badge/runtime%20deps-zero-4b6fff?style=flat-square">
<img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.19-7da1de?style=flat-square">
<img alt="platform" src="https://img.shields.io/badge/platform-win%20%C2%B7%20macOS%20%C2%B7%20linux-2f6f4f?style=flat-square">
<img alt="status" src="https://img.shields.io/badge/status-v0.1.0-f0a441?style=flat-square">

</div>

---

A free-model relay you start with one command: the terminal prints an IP banner and keeps streaming logs; any OpenAI-compatible client on this machine points at `http://127.0.0.1:18899/v1` with the generated key; phones and other machines on your LAN use the same models through the relay door with a **separate LAN key**. The model catalog is refreshed from the OpenCode Zen gateway (https://opencode.ai) — the free lane needs no login and no upstream key.

## Highlights

- **One command** — `./start.sh` (macOS/Linux) or `start.ps1` on Windows (prefer `powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1` — machines whose `.ps1` association points at an editor won't run a bare path) or `start.cmd`: load config → bind listeners first → print the §8.4 banner (local forward port, key tail, LAN addresses, public egress IP filled in asynchronously) → stream foreground logs. SIGINT/SIGTERM shuts down gracefully (ports reclaimed, stats flushed).
- **Zero runtime npm dependencies** — `dependencies` is empty; `typescript` is the only devDependency used for type checking. No build step.
- **OpenAI-compatible surface** — `/v1/chat/completions` (SSE + non-streaming), `/v1/responses`, `/v1/models`, `/health`; tool calls, an 8 MiB body cap and SSE heartbeats included. Every request validates the key (`timingSafeEqual`); after `key rotate` the old key is 401 immediately. Keys are stored 0600 under `data/`.
- **LAN multi-device** — the relay door listens on its own (port 0 auto-assigns by default), gated by a LAN key that is **not** interchangeable with the local one. PROXY v1 device attribution (front-door sniff + unpooled per-request header on the relay) carries the real device IP into the gateway's `x-forwarded-for`, and the local log names the true origin. **The LAN key spends the same free quota — enable it only on networks you trust (home/office LAN, never exposed across an untrusted boundary).**
- **Effort that actually ships** — Light / Balanced / Deep map to real output-token budgets (2 048 / 8 192 / model cap), selectable via `reasoning_effort`, nested `reasoning.effort`, or a `(level)` suffix on the model name. `/v1/models` exposes `x_ofm_efforts` / `x_ofm_effort_default` per row.
- **Three egress modes** — `direct`, `subscription` (failover with three-way fault accounting), or a self-hosted `proxy` URL.
- **Availability probing** — per-model probe outcomes (OK / unavailable / rate-limited / region-limited), a fully-refused round never empties the catalog, and failures are logged without ever blocking the listeners.
- **Your data stays local** — three JSON files under `data/` with debounced, atomic writes; throughput stats only report over a credible decode window (no numbers from too-short windows). The public IP is displayed only, refreshed in the background, never persisted.

## Quick start

Requires Node.js `^22.19.0 || >=24`.

```bash
git clone https://github.com/menghuanshiguang/zenbox
cd zenbox
./start.sh            # Windows: .\start.ps1 or start.cmd
```

The first run generates the key (`data/forward.key`, mode 0600); the banner shows its last four characters. Five seconds after boot a self-test hits `/v1/models`: 200 with the key, 401 without.

Chat in one line:

```bash
curl http://127.0.0.1:18899/v1/chat/completions \
  -H "Authorization: Bearer $(cat data/forward.key)" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Point any OpenAI SDK or chat UI at base URL `http://127.0.0.1:18899/v1` with the key from `data/forward.key`.

## Bundled mihomo (cross-platform egress)

`egress.mode = "subscription"` needs a mihomo binary. zenbox pins one in `vendor/mihomo/manifest.json` (currently v1.19.32) and fetches the official build for your platform into `vendor/mihomo/<os>-<arch>/`:

```bash
node scripts/fetch-mihomo.mjs --smoke                # download + `mihomo -v`
node scripts/fetch-mihomo.mjs --platform linux-arm64 # pre-fetch for another platform
```

- Covers linux / darwin / windows × amd64 / arm64 / 386; CI runs this on all three platforms on every push, so a Linux box only needs one run after cloning.
- Binaries stay out of git (`.gitignore` covers `vendor/mihomo/*/`, the manifest is committed); at runtime `findMihomoBinary` claims the vendored copy first (then PATH, then Clash Verge installs), and the not-found error names the script.
- To upgrade mihomo: edit `version` in the manifest and re-run.

## CLI

| Command | What it does |
| --- | --- |
| `start` (default) | Start the relay: listeners first → banner → background rounds → foreground logs |
| `status` | Ports / key tail / public IP / LAN addresses / relay state; `--json` for machines |
| `models` | Catalog with context lengths; `--json` mirrors `/v1/models` |
| `probe` | Probe cadence and latest round summary; `--json` |
| `key rotate [--lan]` | Rotate the local / LAN key; the old key 401s immediately |
| `doctor` | Check node/config/listeners/key/upstream; exits 1 on any failure |

All commands accept `--json`. Configuration precedence: flag > `OFM_*` env > `config.json` (supports `//` comments) > defaults.

## Testing

```bash
npm test             # L0 static gates + L1 units + L2 integration (stub gateway) + 14 migrated upstream suites
npm run test:live    # L3 live tests (opt-in with --allow-live; the default tier never touches the network)
```

CI runs on ubuntu/amd64, ubuntu/arm64, macOS and Windows: `npm ci`, `npm test`, plus a start smoke test. Module index and dependency map live in [`docs/INDEX.md`](docs/INDEX.md); the fate of all 15 unmerged upstream PRs is tracked line by line in [`docs/pr-coverage.md`](docs/pr-coverage.md); the §12 DoD evidence table is in [`docs/conformance.md`](docs/conformance.md).

## Upstream

This repository was carved out of [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) at its `main` branch (dsh host and distribution surfaces removed) while keeping and porting the applicable unmerged PRs. Three disclaimers: ①client identity — this relay reaches upstream with a fixed pooled credential (`Bearer public`, overridable via `upstream.key`) and fingerprint headers representing your own egress; ②the free lane is served by the OpenCode Zen gateway (https://opencode.ai) directly, connected without third-party relays, and upstream may record prompts to improve its service — **do not send sensitive content**; ③region-limited models are grouped separately by probe verdicts — your egress is not allowed there, they are not removed.

## Planned

- **Docker image** — planned (not in v0.1; the three platform start scripts and bare Node cover the local/LAN cases).

## License

MIT — derived from [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) (also MIT); the carve-out, ports and new code in this repository share the same license. See [LICENSE](LICENSE).
