# webgpu-webgl-benchmarks

Nine key tests for choosing a 3D engine for the web: **three.js**, **PlayCanvas**, **Babylon.js**, **Babylon Lite** and **PixiJS 3D**, measured on WebGPU and WebGL2 in Chrome and Safari.

**Full interactive report:** https://endel.github.io/webgpu-webgl-benchmarks/. The page is a static copy of the generated report, in `docs/index.html`. The first report (three engines, 13 scenarios) stays at [/v1/](https://endel.github.io/webgpu-webgl-benchmarks/v1/) and on [Claude](https://claude.ai/code/artifact/b2f3c482-3d9d-481e-ab0a-0d97620c09a2).

## Results

three.js r187, PlayCanvas 2.24.1, Babylon.js 9.36.0, Babylon Lite 1.39.3 and PixiJS 3D 0.1.0 were measured in Chrome 155 and Safari 26 on an Apple M1 Pro, about 3,400 runs in all, three timing repeats per cell. Numbers are Chrome on WebGPU unless noted; capacities are the largest load that fits a 60 fps frame. Bold marks the best result and any within 5% of it, the report's tie band.

| Test | three.js | PlayCanvas | Babylon.js | Babylon Lite | PixiJS 3D |
|---|---|---|---|---|---|
| K1 Bundle, minimal app (brotli) | 172 KB | 217 KB | 422 KB | **44 KB** | 227 KB |
| K1 Bundle with glTF, shadows, bloom | **194 KB** | 272 KB | 864 KB | **192 KB** | 263 KB |
| K1 Time to first frame, Sponza | 289 ms | **234 ms** | 409 ms | **240 ms** | 297 ms |
| K2 Moving meshes, scene graph | 2.5k | 9.4k | 2.3k | 3.3k | **65.8k** |
| K2 Moving meshes, instanced | 123k | **128k** | 86.6k | **132.9k** | **127k** |
| K3 Churn, typical / worst frame | 13 / 41 ms | 9.8 / 16 ms | 30 / 65 ms | 4.4 / 6.7 ms | **3.6 / 5.2 ms** |
| K4 Sponza + shadows + 31 lights + bloom | 46 ms | 5.1 ms | 6.5 ms | 5.4 ms | **4.3 ms** |
| K4 Sponza with 256 lights | **8.0 ms** | 16 ms | 13 ms | 13 ms | n/a |
| K5 World of 100k meshes, default | 33 ms | 19 ms | 74 ms | over budget | **2.4 ms** |
| K5 World of 100k meshes, static path | 7.1 ms | 5.3 ms | 9.6 ms | **2.1 ms** | 2.4 ms |
| K6 Skinned characters, crossfading | 545 | 593 | 359 | 926 | **2.9k** |
| K6 Skinned crowd, single clip (no crossfade) | 621 | 634 | **32.8k** | ≥ 6.4k† | 4.1k |
| K7 Sorted transparent meshes | 2.4k | 6.8k | 2k | 3k | **15.9k** |
| K7 Compute, 1M particles | **7.4 ms** | **7.2 ms** | **7.2 ms** | 9.7 ms | n/a |
| K8 Pick among 10k meshes | 0.69 ms | 17 ms | 7.5 ms | 4.5 ms | **0.48 ms** |
| K8 Pick on a 1M-triangle mesh | 48 ms | **1.9 ms** | 22 ms | 23 ms | 7.9 ms |
| K9 HUD nameplates over 3D | ≥ 16k* | 547 | 393 | 2.6k | **9k** |
| K9 HUD nameplates, best HUD path | ≥ 16k* | 1.7k | 393 | 2.6k | **9k** |

\* three.js has no UI layer; this is a hand-written quad batcher with canvas text.
† The next level, 12,800 characters, needs a 25,600-texel animation texture, past the GPU's 16,384 limit.

### Takeaways

1. **Instance anything you repeat.** Every engine holds 87k–133k moving meshes once instanced; with one node per object the spread is 2.3k to 66k.
2. **PixiJS 3D batches ordinary meshes for you.** It draws 1,000 separate meshes in 130 calls, which is why it leads the per-object, transparency, crowd and large-world tests. It is a 0.1 release: no clustered lights (32 per view), no compute, no separate baked or instanced crowd path (its default path already batches skinned characters: 800 in 3 draw calls).
3. **Babylon Lite is a tenth of Babylon.js's download** and has the fast paths (baked crowds, GPU-culled instances, compute, GPU picking), but it is WebGPU-only and does not frustum-cull ordinary meshes: a naive 20k-mesh world takes 296 ms a frame.
4. **Past a handful of lights, use a clustered path.** three.js spends 45 ms on 31 forward lights and 8 ms on 256 clustered ones.
5. **Engine UI is not free.** 500 nameplates cost 13 ms a frame in PlayCanvas and 11 ms in Babylon.js; PixiJS 3D's and Babylon Lite's 2D add about 1 ms. PlayCanvas's batch groups triple its count.
6. **WebGPU isn't automatically faster.** three.js's WebGLRenderer sustains 9.1k per-object meshes against 2.5k for its WebGPURenderer; Babylon.js is also ahead on WebGL2.
7. **Test Safari early.** Babylon.js's per-object cost is 4–6× higher there (541 meshes against 2.3k), spawning costs it 220 ms a frame, and its 31-light Sponza takes 198 ms on Safari's WebGPU.

**Which to pick:**
- **PixiJS 3D** if the app is many objects plus a 2D interface and you can live with a 0.1 feature set.
- **PlayCanvas** for a lit scene that loads fast and stays cheap with shadows, lights and post; avoid its element UI for hundreds of moving items.
- **three.js** for the smallest mature download and the biggest ecosystem. Instance heavily, and use its clustered lighting add-on on WebGPU.
- **Babylon Lite** for WebGPU-only projects that want Babylon's fast paths at a small size, built around thin instances.
- **Babylon.js** for the richest built-in feature set (it ran every test on both backends) and by far the biggest baked crowds, at the highest per-object, spawning and download cost.

All numbers come from one machine. Other GPUs and operating systems will rank differently.

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
npm run share-card                                      # report/out/og.png: scoreboard pie, the link preview image
npm test                                                # unit tests, no browser; Node 22.13+
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
| `--resume <session>` | Continue a stopped session (folder name under `results/`) from its saved queue |
| `--restart-every N` | Relaunch the browser after N runs (default 50, 0 = never); the prime runs replay after each launch |
| `--timeout S` | Restart the browser when a run sends nothing for S seconds (default 150) |

**Browser setup.**
- **Chrome** runs from its installed binary with a throwaway profile, with vsync and the frame-rate limit disabled and unquantized WebGPU timestamps enabled. It also runs with `--js-flags=--expose-gc`, so the page can force a garbage collection before each memory snapshot.
- **Firefox** is still supported by the runner (`--browser firefox`) but is no longer part of the published matrix.
- **Safari** is opened with `open -a Safari`. Keep its window frontmost and dismiss any first-run or automation prompts before a session.

A watchdog restarts the browser if a run goes silent for 150 s (`--timeout`). Cells slower than 250 ms per frame stop measuring after 5 frames, except K4 and K5, which always measure whole laps of their camera path.

## Layout

```
bench.html / index.html      run page / landing page
src/harness/                 frame loop, WebGPU + WebGL probes, scene data, matrix, stats
src/harness/frame-cost.ts    frame-cost rule shared by the runner's capacity stop and the report
src/engines/<engine>/        one EngineAdapter per engine, one file per scene kind
src/minimal/<engine>.ts      smallest lit-cube app per engine (bundle size only)
src/realistic/<engine>.ts    glTF + animation + shadows + bloom app per engine (bundle size only)
server/api.ts                run queue + result sink (Vite middleware)
scripts/                     fetch-assets, run, bundle-size, report
results/<session>/           results.jsonl (one line per run) + screenshots
report/                      template.html, findings.json + generated out/
docs/index.html              published copy of the report (GitHub Pages)
```

Unit tests sit next to the modules they cover (`*.test.ts`) and run with `npm test`.

## Key tests

Nine tests, each answering one question you would ask before choosing an engine.

| | Test | Question | Levels | Paths |
|---|---|---|---|---|
| K1 | Startup and shipping | How much does the user download, and how long to the first frame? | lit cube; bundle size of a minimal and a realistic app | naive |
| K2 | Dynamic objects | How many individually moving meshes in a two-level hierarchy, over 16 materials? | 500 → 256k (optimized 4k → 256k) | naive, optimized |
| K3 | Lifecycle churn | What does spawning cost? 20 of 2,000 meshes are destroyed and recreated every frame, each with a new material and texture | 2,000 live | naive |
| K4 | Lit game frame | Sponza with features stacked: base → cascaded shadows → 31 point lights → bloom → 256 lights. The fly-through visits 60 fixed camera poses | 5 steps | naive |
| K5 | Large world visibility | Does cost follow what exists or what is visible? ~2,000 meshes in view either way. The camera turn visits 60 fixed poses | 20k, 100k | naive, optimized |
| K6 | Skinned characters | Fox crowd, every character crossfading two clips. Optimized plays one clip without the crossfade, so it is a lighter workload | 25 → 6,400 (optimized 200 → 51,200) | naive, optimized |
| K7 | Transparency and particles | Sorted alpha-blended meshes; a million compute particles (WebGPU) | 500 → 64k; 1M | naive |
| K8 | Picking | Cost of one pick through the engine's API | 10k meshes; one 1M-triangle mesh | naive, optimized |
| K9 | HUD over 3D | Panels, icons, per-frame text and moving nameplates drawn with the engine's own 2D stack over 1,000 meshes | 0 → 16k nameplates (optimized 250 → 16k) | naive, optimized |

The levels live in `src/harness/matrix.ts`.

K1's bundle total is the initial chunks plus every lazy chunk reachable from the entry, whether or not a WebGPU page ever requests it. The report lists initial and lazy separately.

**Capacity ladders.** K2, K6, K7 and K9 double the load until a level costs more than the 16.7 ms frame budget, then stop. The report interpolates the largest load that fits in a 60 fps frame between the last level inside the budget and the first one over it. A ladder that never goes over budget reads "≥" and is only a lower bound, so `npm run report` warns about it: the ladder should climb until every engine crosses the budget.

**Paths.**
- *Naive* is what a developer following the engine's getting-started docs writes.
- *Optimized* is the engine's best first-party path for the workload. Each run records the path it used. Only first-party packages count.
- An optimized row takes each engine's better result of its naive and optimized paths, and marks it `=` where that is the naive one. No engine is charged an optimized path slower than its default, and every engine gets the same fallback.
- An engine with no separate optimized path fails the optimized cell with `N/A (as naive): …` where the workload is the same as the naive one (K8, K9), so its naive result stands. Where the workload differs (K6's single-clip crowd) the default path runs it.
- A cell fails with `N/A: …` only where the engine cannot run the workload at all (no compute API, more lights than it shades). It is reported as not applicable, with the reason, and scores zero.
- K9's optimized variant changes only the HUD path: the engine's first-party batching for the same HUD. The meshes under it are built the same way on both paths.

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
  - A frame starts only once the frame before last has finished on the GPU, so at most one frame is in flight: `onSubmittedWorkDone` on WebGPU, a fence (`fenceSync`, polled between tasks) on WebGL2. Without this, an uncapped browser lets JavaScript run ahead until the GPU queue is full and then blocks whichever call meets the full queue (`getCurrentTexture` or `submit` on WebGPU, any GL call on WebGL2). CPU time would then measure where that wait lands: in Chrome it moved by up to 0.7 ms with the number of submits per frame on WebGPU, and on WebGL2 it put a 3 ms tail on a lit cube whose CPU median is 0.2 ms.
- **GPU time:** measured by an engine-agnostic probe that patches the WebGPU prototypes before any engine loads.
  - The probe adds `timestamp-query`, writes timestamps around every pass (never mutating the engine's own descriptors) and resolves them asynchronously, so there are no stalls.
  - The report's GPU time is *busy* time: the union of the frame's pass intervals, so passes that overlap on tile-based GPUs count once and idle gaps between an engine's submits don't count.
  - The probe also records the *span* (first pass start to last pass end) and the *sum* of pass durations. Results without busy time fall back to the smaller of the two.
  - Not every frame resolves its timestamps. The report shows how many frames were timed per cell, and marks GPU figures that rest on fewer than 30 timed frames with ‡.
  - Chrome runs with vsync and the frame-rate limit off, so its frame interval reflects throughput, and GPU time is the GPU cost. Safari's capped loop stays coupled to the GPU, which makes it the cross-check for GPU-heavy scenes.
- **Render cross-check:** any run in another browser that issues fewer than half of Chrome's draw calls for the same cell is reported as failed, in every test. A shader can fail without raising a GPU error, leaving healthy-looking timings for an empty frame.
- **Render guard:** in the tests with every object in view (K1, K2, K7, K8, K9), a counters run that draws under 98% of the scene's triangles is reported as failed. Indirect draws count with the triangles read back from their arguments; a run whose arguments couldn't be read is noted as unchecked rather than judged. A naive run with fewer draw calls than objects is noted as batching automatically.
- **Load and startup times** use the fastest repeat, since the first load of an asset hits a cold HTTP cache.
- **Pacing:** frames over the 16.7 ms and 33.3 ms budgets and the worst frame, for CPU time and for the frame interval. K3 is judged on these.
- **Memory growth:** JS heap and live GPU bytes at the start and end of the measurement (live buffer and texture counts on WebGL2, where sizes aren't visible). The page forces a garbage collection before each heap snapshot where the browser allows it (Chrome launched by the runner), and the report shows heap growth only for those runs.
- **Picks:** timed one at a time after the frame measurement, three passes over 64 fixed points. The hit ids are recorded, and the report takes the majority id per point across every engine, backend and path in a browser and shows each engine's agreement with it. A point where the top answers tie has no majority and is left out.
- **Frame interval:** real throughput where the browser is uncapped.
- **Frame cost** = max(CPU p95, GPU p95, frame interval p50). It drives the "max N at 60 fps" figure and the runner's capacity stop.
  - With at most one frame in flight, the CPU tail is the engine's own work, hitches included, so it is charged in full.
  - The frame interval catches time spent in neither the page's JavaScript nor the GPU's passes, such as work the browser's GPU process does for the page. For most engines it matches the CPU or GPU time; at high loads Babylon Lite's frames take several times longer than either.
  - In Safari, which is capped at the display rate, the interval counts only above 20 ms.
- **Counters run:** a separate run that wraps the hot calls (draws, `setPipeline`, `setBindGroup`, `writeBuffer`, submits), tracks live buffer and texture bytes, and cross-checks draw counts against the engine's own stats. Draws recorded in render bundles count each time a bundle executes, and WebGL2 multi-draw calls count every draw they contain. Indirect draws are counted separately, and their arguments are copied out after each pass and read back, so their instances and triangles are known too (the probe adds `COPY_SRC` to indirect buffers in counters runs only).
- **Startup:** import, init, load, first frame and time-to-first-frame. Also JS heap and any pipelines created mid-measurement, which flag the run.

**Protocol.**
- Warm-up runs until no new pipeline has appeared for 30 frames (at least 90 frames and 1.5 s).
- Measurement covers at least 240 frames and 3 s (capped at 15 s for very slow levels), repeated as separate page loads; the median is reported.
- K4 and K5 render laps of 60 fixed camera poses. Warm-up renders every pose once, measurement covers whole laps, and a run that can't finish one lap fails.
- Counters runs measure 1 s, since they only need per-frame call medians.
- Engine order is shuffled within each block.
- A canary cell reruns periodically to detect thermal drift.
- Short prime runs replay at the start of every browser launch, because a graphics context's position in the browser process shifts its cost.
- A capacity ladder stops one level past the frame budget, judged by the frame-cost rule; any other ladder stops once a level takes more than 100 ms per frame.
- K3 measures for at least 600 frames and 10 s, so every slot is respawned several times.

**Fairness.**
- Every engine renders at 1920×1080 device pixels, with 4× MSAA, ACES tone mapping, sRGB output and an opaque canvas, from production builds.
- Light units are calibrated so screenshots match: three.js and Babylon.js divide Lambert diffuse by π, PlayCanvas does not.
- Babylon Lite has no ACES tone mapping, so its exposure is matched instead.

## Known caveats

- Results come from one machine per session; the reference runs are on an Apple M1 Pro under macOS 26. Other GPUs and OSes rank differently.
- Safari cannot be uncapped, so its frame interval is the display rate; CPU and GPU times carry the comparison there.
- The use-case index in the report scores each test on a log scale against the best engine and weights the tests by this project's judgement; its limits are listed above the table, and the scoreboard has the raw numbers. three.js has no UI layer, so its hand-written HUD is shown unranked and scores zero in the index.
