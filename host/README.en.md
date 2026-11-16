# ProkBot Plus Host Patch

Self-host the Grok Bot server. The Host builds for Linux amd64 or arm64; the original execution desktop is amd64 only. ARM can use a separate amd64 node or local emulation (experimental). Requires Python 3.10+ and Docker Compose v2.

For deployment see the [AI install guide](../docs/AI-INSTALL.en.md); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md). The [whole-machine benchmarks](#capacity-benchmark) are for authorized non-production VMs only. They are not a machine backup tool and do not establish minimum hardware requirements.

[简体中文](README.md)

## Use

```sh
python3 deploy.py doctor
python3 deploy.py init
python3 deploy.py up
```

Run these from `host/`; a new install defaults to loopback. Set a custom access address at `init` (see `python3 deploy.py init --help`). For an existing instance use `update`, not `init`. See the install guide for setup, model configuration and pairing.

## Offline builds

By default the build tool downloads the original files from pinned sources and verifies them strictly; see `recipes/host/manifest.json` and `release/build-docker.py` for the versions. If you already have the original files:

```sh
python3 deploy.py up --host-archive /path/to/host.tgz --box-archive /path/to/box.tar.gz
```

After verification the Box archive is tagged `grokbot-box-input:9d2ac1b`, and Compose uses that local image. New Docker 29 installations use the containerd image store, where the image ID is the pinned manifest digest; the build tool accepts it. Offline archives are verified by their config digest regardless of the store.

Select the instance with `init` first; use `update` instead of `up` for an existing instance. For build-only work `release/build-docker.py` accepts the same archive flags. These replace only upstream downloads. A fully offline build needs cached base images, OS packages, npm dependencies and, on local ARM, amd64 `busybox:1.37`. Omit `--box-archive` for a split ARM Host; amd64 Hosts still use Box as their base.

`release/patch-host.py --archive ORIGINAL --output NEW_DIRECTORY` generates the Host files on their own and records the patch time. It only copies fixed bytes and applies added rules; it does not call an AI or decompile anything.

## Data and backups

Local mode backs up `host-data`, `box-home` and `box-workspace`. A split Host has only `host-data`; back up `gateway-data` and both desktop volumes separately on the execution machine. The backup directory contains only volume archives and a checksum manifest, **not images, the instance directory's `.env`, the host OS or other disk contents**. Volumes can hold device identities, model credentials, chats and workspace files. Keep the backup private.

A manual backup pauses running project containers and restores their original state. `update` builds the candidate first, then stops the old services before taking the volume backup so it includes writes made during the build. An unmanaged submount such as `/data/uploads` blocks the operation. A split deployment is not an atomic cross-machine snapshot: the operator must coordinate stopping writes on both sides and retain the two sets of archives separately.

```sh
python3 deploy.py backup < /dev/null
```

**Restore and start a new instance.** Keep the volume backup, original instance `.env`, matching code revision and images separately. `serviceImages` records the full IDs of the actual containers' images, not their contents. The target daemon must already have those exact images; the old Host's local `prokbot-recovery` tag is not an image backup. Confirm the original instance and any copy of its identity on other machines are stopped. Do not run `down -v` on the source project.

Run from `host/`. This local-desktop example uses loopback. Choose a fresh home and project and substitute the actual backup directory. To keep existing pairings usable, give `init` the original `--listen`, `--port` and `--public-url` and carry over settings such as the time zone into the new `.env`. For a split Host add `--host-only` before `init`; subsequent commands remember the mode. Never overwrite the original `.env`:

```sh
python3 deploy.py --home "$HOME/grokbot-restored" --project grokbot-restored init < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" recover --directory /path/to/backup < /dev/null
python3 deploy.py --home "$HOME/grokbot-restored" status < /dev/null
```

`recover` checks every archive checksum, project name, topology and local image ID. It extracts only into a new project, starts with existing restored volumes and the recorded images, and verifies the running images and mounts. It neither builds nor pulls nor modifies the source volumes. Check that a previously paired device can read its conversation and workspace file. On startup failure the target volumes are retained; the original instance is not restarted. If shutdown could not be confirmed, inspect the services before starting another copy of the identity.

Automatic recovery cannot start a Host if an old manifest does not establish its identity lineage, lacks complete `serviceImages`, or the exact images are missing locally. Never guess the version from `:local` or infer old images from volumes left without their original containers. For data-only restore, run `python3 release/backup.py restore --project grokbot-data-only --directory /path/to/backup --image <verified-local-image-ID> < /dev/null`. This starts no services and also works on the separate execution machine. Recover trusted images and configuration and rule out an identity conflict before arranging a restart.

On one Docker daemon, `prokbot-operation-<project>` serializes project changes, `prokbot-lineage-operation-<original-project>` prevents simultaneous activation of related copies, and `prokbot-image-publication-lock` serializes publication of shared image tags. These locks do not depend on the instance home or port. **Separate daemons do not share locks or inspect one another's instances.** Manual container starts are also outside these controls. Confirm only one copy of an identity is active. A crash can leave a lock behind: inspect the operation, services, volumes and backup; removing a lock is not a routine recovery step. A `<project>_restore-in-progress` volume marks an incomplete restore: do not start that project. Preserve it for inspection and retry into another empty project.

## Separate execution computer

On the Host use `python3 deploy.py --host-only init` then `python3 deploy.py up`. Deploy the execution node from `host/` on a separate **amd64 Linux** machine:

```sh
python3 release/build-docker.py --box-only
# Set a random GROKBOT_NODE_TOKEN of at least 32 characters. Add --box-archive above for an offline image.
docker compose -f release/compose.execution.yaml up -d --build
```

Then enter the node's address and key in the Host console and enable it. In `--host-only` mode, the chat core starts only after a model is configured and a remote execution node enabled. Without the node, the console can open and the container can report healthy; this is not a standalone chat configuration.

- LAN access: set `GROKBOT_NODE_LISTEN_ADDRESS=0.0.0.0`. The default port is 18443.
- Embedded networking: set `GROKBOT_TAILCAT_ENABLED=1`. Advanced options are `GROKBOT_TAILCAT_RELAY` and `GROKBOT_TAILCAT_DERP_MAP_URL`.

<a id="capacity-benchmark"></a>
## Whole-machine benchmarks

The [sampler](bench/guest.py) observes dedicated, authorized non-production Linux VMs; an operator builds, starts and drives the workload. No production services, volumes or credentials. Use the same observer version for both sides.

| `--mode` | Roles, architectures and Compose services |
| --- | --- |
| `x86-local` | Native, colocated: amd64 `host` role, `host` + `box`. |
| `arm-split` | arm64 `host`: `host`; separate amd64 `desktop`: `gateway` + `box`. Capture and report both. |
| `arm-emulated` | Experimental, colocated: arm64 `host` with native `host` + emulated amd64 `box`. Exercise the actual desktop. |
| `host-only` | amd64/arm64 `host` alone: setup/idle only. Without a node retain missing phases and failures. Even all-success receipts never qualify; with a node measure both split machines. |

Requires a VM recognized by `systemd-detect-virt --vm`, Python 3.10+, `/proc`, cgroup v2 (CPU/memory/swap/cpuset) and local Docker CLI access to `/var/run/docker.sock`, data root and target process files. No bare metal, WSL, containers, remote Docker or rootless/custom sockets.

**Capture.** Run from the guest's `host/`. Pre-create a private round directory outside the checkout; use the exact local Compose project label and a new file. For split use `--mode arm-split` and one `--run-id` on both VMs, substituting `--role desktop`, its project and `desktop.jsonl` on the execution VM.

```sh
R=/path/to/private-bench
python3 -B bench/bench.py sample --isolated-guest --mode x86-local --role host \
  --project benchdemo --run-id before-1 --out "$R/BEFORE/1/host.jsonl" --interval 5 --duration 5400
```

Sync driver, client and guest UTC clocks. Wait for `sampling-ready` on stderr from every role before build/start; leave one tick outside each end. Size duration to fit (5400 seconds is illustrative, 30 is diagnostic). Root and Docker data disks are included; repeat `--disk LABEL=/existing/directory` for separate containerd, cache, data or input filesystems. Do not sum aliases.

**Round inputs.** `run.json`, `actions.jsonl`, `host.jsonl`; only split adds `desktop.jsonl`. See the [validator](bench/evidence.py) and [field example](tests/benchmark_checks.py) (`fixture` is not a measurement).

| Required `run.json` fields | Values |
| --- | --- |
| `schema`, `runId`, `mode`, `revision` | `1`, unique public round alias, mode above, deployed 40/64-digit lowercase hex ID. For uncommitted changes use a reproducible source-tree/artifact SHA-256. |
| `origin`, `modelKind` | `measured` / `probe` / `synthetic`; `external-api` / `local-inference` / `mock` / `none`. Only `measured` + `external-api` qualifies for review; study local inference separately. |
| `workloadSha256`, `datasetSha256`, `limitsSha256`, `modelConfigSha256` | Hash the plan (cold cache, idle, concurrency, cadence, deadlines), starting data, VM provisioning/service limits and non-secret model/endpoint/settings, in order. Reset only approved disposable state. |
| `provisioned`, `phases` | Per-role VM `vcpus`, `ramBytes`, not container limits; retain CPU/acceleration, ballooning, swap, disks and clock-sync records. Phase `startMs`, `endMs` are ordered non-overlapping Unix UTC milliseconds. |
| `traceSha256`, `actionLogSha256` | On successful sampler exit, use `sha256sum` for raw capture digests keyed by role and the complete action-log digest. Missing roles/footers, gaps or mismatches cannot pass. |

`actions.jsonl`: one line per attempt with `runId`, `phase`, `check`, unique `id`, stable anonymous `client`, in-phase `startMs`/`endMs`, boolean `ok`, `source`, redacted artifact digest `evidenceSha256`. Use `build-log` for builds, `real-client` otherwise; `fixture` / `probe` / `synthetic` are diagnostic. Missed delivery stays `ok:false` with error evidence even if late; retries are separate. For chat, `upstreamMs` is the duration of the union of upstream waits including retries, or `null`. The remainder includes client, network, tools and orchestration, not just Host time.

| Phase, in order | Real receipts and conditions |
| --- | --- |
| `build` (optional) | Include acquisition and build; `pinned-inputs`, `image-ready` on each role with `client` set to its name. Omission leaves build unmeasured. |
| `cold` | Start with services stopped/absent. Paired `client-ready` finishes after every required service on every role starts cleanly once. Time from phase start, not spawn or health. |
| `idle` | No work for ≥60 seconds; poll for client `idle-healthy` at a fixed low cadence. |
| `chat` | One client gets `chat-reply`, then a `context-reply` that depends on the first. |
| `desktop` | Usable `desktop-frame` and visible effect of benign `desktop-input`, not a handshake. Forbidden in `host-only`, required otherwise. |
| `restart` | Restart only the Host container, once. After observed `die` then `start` and generation change, the original paired context-chat client begins `identity-restored` and `history-restored`. An alias alone is not proof. |
| `soak` | ≥1 hour of real load per round; successful `chat-reply` gaps ≤60 seconds including both ends (e.g. schedule every 30 seconds). Desktop checks may accompany chats; sleeping does not count. |
| `concurrent` (needed for a recommendation) | Overlap successful `chat-reply` from ≥2 distinct clients. Per VM count ≥3 full adjacent-sample intervals wholly inside overlaps, totaling ≥60 seconds; credit at most one tick per interval. `overlapHeadroom`: minimum `MemAvailable` ≥10%, p95 non-idle CPU ≤90%. Passing does not assign a tier. |

**Offline comparison.** From the controller's `host/`, set `R` to its private record root. Finish `BEFORE/1`, `BEFORE/2`, `BEFORE/3`… before matching `AFTER` rounds. Keep ≥3 independent pairs, including failures, without gaps or reuse. Match environments, allocations, limits, data, model, plan and each phase's distribution of attempted checks per client. Group different conditions separately. Both revisions and observed running Host image digests must differ.

```sh
python3 -B bench/bench.py validate "$R/BEFORE/1" > "$R/round-report.json"
python3 -B bench/bench.py compare --before "$R/BEFORE" --after "$R/AFTER" > "$R/comparison.json"
```

Both accept `--evidence-dir "$R/sources"`: store redacted client, UI, build and readback artifacts privately outside cohorts, named by SHA-256 without extensions. Missing/mismatched files fail; without this option only traces, logs and receipt references are checked. Hashes verify bytes, not operations. Review originals, build provenance, endpoints, cadence and deadlines.

Exit `0`: one round / ≥3 pairs eligible for review, not certification. `1`: readable but failed, incomplete, synthetic or too few rounds; metrics/reasons retained, no comparative deltas. `2`: invalid input or unmatched controls; see stderr or `invalidEvidence` with other readable rounds, then diagnose with `validate`. Eligible comparisons give side medians and paired after-minus-before deltas.

[Metric calculations](bench/telemetry.py), `summarize`: guest CPU percentages are not container cores; guest RAM is not container RAM or RSS. Sampled peaks are lower bounds; disk includes system writes and phase bounds can include a neighboring tick. OOM or unexpected project-container lifecycle fails a round; do not sum OOM across layers. Check app recovery in receipts/logs. Disclose swap capacity, use and paging deltas; paging at zero capacity fails. Retest without swap before claiming it unnecessary.

The minimum and recommended configurations under [server requirements](../README.en.md#server-requirements) cover personal use only. The 2C2G timeouts, 2C4G/4C8G functional runs and historical A1 checks behind them, and the [same-disk patcher timings](../docs/ARCHITECTURE.en.md#host-patch-measurement), are not capacity comparisons. Offline smoke: `python3 -B bench/bench.py selftest`; options: `sample --help`; regressions: `node --test "tests/benchmark*.test.mjs"`.

## App development

Applications in the console manage remote MCP services, apps with code and bundled skills. One app is one `grokbot-app` JSON package; old plugin JSON files can still be imported.

- The built-in "Write an app" tool provides the guide, format validation and submission. After a Bot submits an app, the user adds and authorizes it in the client's original Connected Apps screen.
- Import and export use a single JSON file with code, icon, description and skills. Saved configuration and credentials are never exported.
- Code apps run as MCP processes on the existing execution computer, without extra containers. They share that computer's user permissions, files and network with its other tasks.
- OAuth supports PKCE, one-time state and refresh on expiry. The developer declares the authorization URL, token URL and scopes; the user enters the Client ID/Secret and opens the provider's authorization page from the client.
- Substantial coding work calls Codex on a connected computer, with that computer's model settings and login.
- App versions are immutable; after an upgrade you can restore the previous version.

For the full package format, a runnable example and OAuth examples see [server/application-guide.md](server/application-guide.md). This is the same guide a Bot reads when it writes an app.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most code in this project was generated with AI assistance.
