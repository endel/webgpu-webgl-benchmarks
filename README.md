# webgpu-webgl-benchmarks

Nine key tests for choosing a 3D engine for the web: **three.js**, **PlayCanvas**, **Babylon.js**, **Babylon Lite** and **PixiJS 3D**, measured on WebGPU and WebGL2 in Chrome and Safari.

**Full interactive report:** https://endel.github.io/webgpu-webgl-benchmarks/. The page is a static copy of the generated report, in `docs/index.html`. The first report (three engines, 13 scenarios) stays at [/v1/](https://endel.github.io/webgpu-webgl-benchmarks/v1/) and on [Claude](https://claude.ai/code/artifact/b2f3c482-3d9d-481e-ab0a-0d97620c09a2).

## Results

three.js r187, PlayCanvas 2.24.1, Babylon.js 9.36.0, Babylon Lite 1.39.3 and PixiJS 3D 0.1.0 were measured in Chrome 155 and Safari 26 on an Apple M1 Pro, about 1,700 runs in all, one timing repeat per cell. Numbers are Chrome on WebGPU unless noted; capacities are the largest load that fits a 60 fps frame.

| Test | three.js | PlayCanvas | Babylon.js | Babylon Lite | PixiJS 3D |
|---|---|---|---|---|---|
| K1 Bundle, minimal app (brotli) | 172 KB | 217 KB | 422 KB | **44 KB** | 278 KB |
| K1 Bundle with glTF, shadows, bloom | 194 KB | 272 KB | 864 KB | **192 KB** | 298 KB |
| K1 Time to first frame, Sponza | 510 ms | **265 ms** | 964 ms | 467 ms | 363 ms |
| K2 Moving meshes, scene graph | 2.8k | 10.1k | 2.2k | 2.5k | **≥ 64k** |
| K2 Moving meshes, instanced | 129k | 132k | 88k | 133k | **160k** |
| K3 Churn, typical / worst frame | 12 / 77 ms | 9.3 / 17 ms | 29 / 84 ms | 5.7 / 13 ms | **3.3 / 5.0 ms** |
| K4 Sponza + shadows + 31 lights + bloom | 34 ms | **5.1 ms** | 7.1 ms | 5.3 ms | 6.9 ms |
| K4 Sponza with 256 lights | **8.1 ms** | 25 ms | 19 ms | 13 ms | n/a |
| K5 World of 100k meshes, default | 29 ms | 19 ms | 67 ms | failed | **1.0 ms** |
| K5 World of 100k meshes, static path | 7.2 ms | 5.1 ms | 8.9 ms | 3.3 ms | **1.0 ms** |
| K6 Skinned characters, crossfading | 609 | 650 | 390 | **≥ 800** | **≥ 800** |
| K6 Skinned crowd path | n/a | n/a | **≥ 3,200** | **≥ 3,200** | n/a |
| K7 Sorted transparent meshes | 2.4k | 6.8k | 1.9k | 2.9k | **30.6k** |
| K7 Compute, 1M particles | 16 ms | **11 ms** | 15 ms | 13 ms | n/a |
| K8 Pick among 10k meshes | 0.92 ms | 18 ms | 6.8 ms | 3.6 ms | **0.47 ms** |
| K8 Pick on a 1M-triangle mesh | 47 ms | **0.91 ms** | 22 ms | 23 ms | 7.9 ms |
| K9 HUD nameplates over 3D | ≥ 16k* | 546 | 399 | 2.1k | **9.7k** |

\* three.js has no UI layer; this is a hand-written quad batcher with canvas text.

### Takeaways

1. **Instance anything you repeat.** Every engine holds 88k–160k moving meshes once instanced; with one node per object the spread is 2.2k to 64k.
2. **PixiJS 3D batches ordinary meshes for you.** It draws 1,000 separate meshes in 130 calls, which is why it leads the per-object, transparency and large-world tests. It is a 0.1 release: no clustered lights (32 per view), no compute, no skinned-crowd path.
3. **Babylon Lite is a tenth of Babylon.js's download** and has the fast paths (baked crowds, GPU-culled instances, compute, GPU picking), but it is WebGPU-only and does not frustum-cull ordinary meshes: a naive 100k-mesh world never finished a frame.
4. **Past a handful of lights, use a clustered path.** three.js spends 70 ms on 31 forward lights and 8 ms on 256 clustered ones.
5. **Engine UI is not free.** 500 nameplates cost 13 ms a frame in PlayCanvas and 10 ms in Babylon.js; PixiJS 3D's native 2D adds under 1 ms.
6. **WebGPU isn't automatically faster.** three.js's WebGLRenderer sustains 9.0k per-object meshes against 2.8k for its WebGPURenderer; Babylon.js is also ahead on WebGL2.
7. **Test Safari early.** Babylon.js's per-object cost is about 4× higher there (590 meshes against 2.2k), and two of its WebGPU runs failed and passed on a repeat.

**Which to pick:**
- **PixiJS 3D** if the app is many objects plus a 2D interface and you can live with a 0.1 feature set.
- **PlayCanvas** for a lit scene that loads fast and stays cheap with shadows, lights and post; avoid its element UI for hundreds of moving items.
- **three.js** for the smallest mature download and the biggest ecosystem. Instance heavily, and use its clustered lighting add-on on WebGPU.
- **Babylon Lite** for WebGPU-only projects that want Babylon's fast paths at a small size, built around thin instances.
- **Babylon.js** for the richest built-in feature set (it ran every test on both backends), at the highest per-object, spawning and download cost.

All numbers come from one machine and one repeat. Other GPUs and operating systems will rank differently.

Every engine renders the same deterministic scenes: identical geometry, transforms, materials, lights, camera and HUD layout, all generated from a seeded RNG. The harness owns the only `requestAnimationFrame` loop, and every page load measures exactly one configuration.

## Quick start

```sh
npm install
npm run fetch-assets                                    # Khronos Sponza, Fox, HUD font → public/assets
npm run bench -- --browser chrome --profile smoke       # correctness pass, ~5–10 min
npm run bench -- --browser chrome --profile quick       # one repeat, Chrome only
npm run bench -- --browser chrome,safari --profile full
npm run bundle-size                                     # results/bundle-size.json
npm run report                                          # report/out/index.html
```

`npm run dev` serves `index.html`, which links every scenario in *standalone* mode: the scene renders continuously with a live HUD and nothing is recorded.

### Runner options

| Flag | Meaning |
|---|---|
| `--browser chrome,safari` | Sessions run one after another, one results folder each |
| `--profile smoke\|quick\|full` | `smoke` runs every cell once in counters mode and takes screenshots. `quick` is one timing repeat plus counters. `full` is three timing repeats plus counters |
| `--only "engine=three,babylon;scenario=k2;backend=webgpu"` | Filter the matrix by `engine`, `backend`, `scenario`, `variant` or `level` |
| `--opt <name>` | Force a named optimized-path candidate on optimized runs |
| `--repeats N` | Override the profile's repeat count |
| `--port N` | Serve on another port. Each port builds into its own `dist-N`, so runners can run side by side |
| `--no-gpu-timing` | Skip timestamp-query injection |
| `--no-build` | Reuse the last build |

**Browser setup.**
- **Chrome** runs from its installed binary with a throwaway profile, with vsync and the frame-rate limit disabled and unquantized WebGPU timestamps enabled.
- **Firefox** is still supported by the runner (`--browser firefox`) but is no longer part of the published matrix.
- **Safari** is opened with `open -a Safari`. Keep its window frontmost and dismiss any first-run or automation prompts before a session.

A watchdog restarts the browser if a run goes silent for 150 s (`--timeout`). Cells slower than 250 ms per frame stop measuring after 5 frames.

## Layout

```
bench.html / index.html      run page / landing page
src/harness/                 frame loop, WebGPU + WebGL probes, scene data, matrix, stats
src/engines/<engine>/        one EngineAdapter per engine, one file per scene kind
src/minimal/<engine>.ts      smallest lit-cube app per engine (bundle size only)
src/realistic/<engine>.ts    glTF + animation + shadows + bloom app per engine (bundle size only)
server/api.ts                run queue + result sink (Vite middleware)
scripts/                     fetch-assets, run, bundle-size, report
results/<session>/           results.jsonl (one line per run) + screenshots
report/                      template.html, findings.json + generated out/
docs/index.html              published copy of the report (GitHub Pages)
```

## Key tests

Nine tests, each answering one question you would ask before choosing an engine.

| | Test | Question | Levels | Paths |
|---|---|---|---|---|
| K1 | Startup and shipping | How much does the user download, and how long to the first frame? | lit cube; bundle size of a minimal and a realistic app | naive |
| K2 | Dynamic objects | How many individually moving meshes in a two-level hierarchy, over 16 materials? | 500 → 64k (optimized 4k → 256k) | naive, optimized |
| K3 | Lifecycle churn | What does spawning cost? 20 of 2,000 meshes are destroyed and recreated every frame, each with a new material and texture | 2,000 live | naive |
| K4 | Lit game frame | Sponza with features stacked: base → cascaded shadows → 31 point lights → bloom → 256 lights | 5 steps | naive |
| K5 | Large world visibility | Does cost follow what exists or what is visible? ~2,000 meshes in view either way | 20k, 100k | naive, optimized |
| K6 | Skinned characters | Fox crowd, every character crossfading two clips | 25 → 800 (optimized 200 → 3,200) | naive, optimized |
| K7 | Transparency and particles | Sorted alpha-blended meshes; a million compute particles (WebGPU) | 500 → 64k; 1M | naive |
| K8 | Picking | Cost of one pick through the engine's API | 10k meshes; one 1M-triangle mesh | naive, optimized |
| K9 | HUD over 3D | Panels, icons, per-frame text and moving nameplates drawn with the engine's own 2D stack over 1,000 meshes | 0 → 16k nameplates | naive |

The levels live in `src/harness/matrix.ts`.

**Capacity ladders.** K2, K6, K7 and K9 double the load until a level costs more than the 16.7 ms frame budget, then stop. The report interpolates the largest load that fits in a 60 fps frame between the last level inside the budget and the first one over it.

**Paths.**
- *Naive* is what a developer following the engine's getting-started docs writes.
- *Optimized* is the fastest documented path for the same image. Each run records the path it used.
- A cell whose engine has no such path fails with `N/A: …` and is reported as not applicable, with the reason. Only first-party packages count.

**Engines and backends.**

| Engine | WebGPU | WebGL2 |
|---|---|---|
| three.js | `WebGPURenderer` | classic `WebGLRenderer` |
| PlayCanvas | yes | yes |
| Babylon.js | yes | yes |
| Babylon Lite | yes | none |
| PixiJS 3D | yes | yes |

## What is measured

- **CPU time:** `performance.now()` around the engine's update and render call. The shared scene simulation is timed separately and excluded.
- **GPU time:** measured by an engine-agnostic probe that patches the WebGPU prototypes before any engine loads.
  - The probe adds `timestamp-query`, writes timestamps around every pass (never mutating the engine's own descriptors) and resolves them asynchronously, so there are no stalls.
  - The probe records two readings per frame. The *span* runs from the first pass start to the last pass end, and it counts idle gaps when an engine submits passes while the CPU is still building the frame. The *sum* adds up individual pass durations, and it double-counts passes that overlap on tile-based GPUs.
  - The report's GPU time is the smaller of the two, since true busy time can't exceed either.
  - With vsync and the frame-rate limit off, Chrome lets JavaScript run ahead of the GPU (commands queue in the GPU process). Its frame interval then reflects CPU-side throughput, and GPU time is the GPU cost. Safari's capped loop stays coupled to the GPU, which makes it the cross-check for GPU-heavy scenes.
- **Render cross-check:** any run in another browser that issues fewer than half of Chrome's draw calls for the same cell is reported as failed. A shader can fail without raising a GPU error, leaving healthy-looking timings for an empty frame.
- **Load and startup times** use the fastest repeat, since the first load of an asset hits a cold HTTP cache.
- **Pacing:** frames over the 16.7 ms and 33.3 ms budgets and the worst frame, for CPU time and for the frame interval. K3 is judged on these.
- **Memory growth:** JS heap and live GPU bytes at the start and end of the measurement (live buffer and texture counts on WebGL2, where sizes aren't visible).
- **Picks:** timed one at a time after the frame measurement, three passes over 64 fixed points; the hit ids are recorded so engines can be compared.
- **Frame interval:** real throughput where the browser is uncapped.
- **Frame cost** = max(CPU p95, GPU p95). It's independent of vsync, and it drives the "max N at 60 fps" figure. In Safari, which is capped and has no GPU timer on WebGL2, a frame interval above 20 ms counts as the frame cost too.
- **Counters run:** a separate run that wraps the hot calls (draws, `setPipeline`, `setBindGroup`, `writeBuffer`, submits), tracks live buffer and texture bytes, and cross-checks draw counts against the engine's own stats.
- **Startup:** import, init, load, first frame and time-to-first-frame. Also JS heap and any pipelines created mid-measurement, which flag the run.

**Protocol.**
- Warm-up runs until no new pipeline has appeared for 30 frames (at least 90 frames and 1.5 s).
- Measurement covers at least 240 frames and 3 s (capped at 15 s for very slow levels), repeated as separate page loads; the median is reported.
- Counters runs measure 1 s, since they only need per-frame call medians.
- Engine order is shuffled within each block.
- A canary cell reruns periodically to detect thermal drift.
- A capacity ladder stops one level past the frame budget; any other ladder stops once a level takes more than 100 ms per frame.
- K3 measures for at least 600 frames and 10 s, so every slot is respawned several times.

**Fairness.**
- Every engine renders at 1920×1080 device pixels, with 4× MSAA, ACES tone mapping, sRGB output and an opaque canvas, from production builds.
- Light units are calibrated so screenshots match: three.js and Babylon.js divide Lambert diffuse by π, PlayCanvas does not.
- Babylon Lite has no ACES tone mapping, so its exposure is matched instead.

## Known caveats

- Results come from one machine per session; the reference runs are on an Apple M1 Pro under macOS 26. Other GPUs and OSes rank differently.
- Safari cannot be uncapped, so its frame interval is the display rate; CPU and GPU times carry the comparison there.
- The use-case index in the report scores each test on a log scale against the best engine and weights the tests by this project's judgement; its limits are listed above the table, and the scoreboard has the raw numbers. three.js has no UI layer, so its hand-written HUD is shown unranked and scores zero in the index.
