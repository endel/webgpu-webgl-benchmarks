// Renders the scoreboard share card, a pie of benchmarks won per engine, which is also the report's Open Graph image.
//   npm run report && npm run share-card   → report/out/og.png (publish it as docs/og.png next to docs/index.html)
// The win counts come from the generated report itself: its own scoring code runs in headless Chrome, so the card
// always matches the scoreboard. Logos in report/logos: Simple Icons (CC0) and PixiJS's own branding files.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const REPORT = join(ROOT, 'report', 'out', 'index.html');
const OUT = join(ROOT, 'report', 'out', 'og.png');
const LOGOS = join(ROOT, 'report', 'logos');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1600, H = 900, SCALE = 2;
const MAIN_VIEW = { browser: 'Chrome', backend: 'webgpu' };

interface View { browser: string; backend: string; rows: number; wins: Record<string, number> }
type Logo = { d: string } | { img: string; w: number; h: number };

// The report's dark-theme hues, with PlayCanvas and Babylon Lite re-stepped so they stay apart where they share an edge.
// Pink can sit next to green only across the lifted winner's gap; logos and counts name every slice anyway.
const svgPath = (file: string) => readFileSync(join(LOGOS, file), 'utf8').match(/<path d="([^"]+)"/)![1];
const pixi = { img: `data:image/svg+xml;base64,${readFileSync(join(LOGOS, 'pixijs.svg')).toString('base64')}`, w: 735, h: 289 };
const ENG: Record<string, { color: string; ink: string; logo: Logo }> = {
  three: { color: '#3987e5', ink: '#ffffff', logo: { d: svgPath('threejs.svg') } },
  playcanvas: { color: '#d4343a', ink: '#ffffff', logo: { d: svgPath('playcanvas.svg') } },
  babylon: { color: '#199e70', ink: '#ffffff', logo: { d: svgPath('babylonjs.svg') } },
  'babylon-lite': { color: '#b68e00', ink: '#121513', logo: { d: svgPath('babylonjs.svg') } },
  pixi3d: { color: '#d55181', ink: '#ffffff', logo: pixi },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Headless Chrome with one page, driven over the DevTools protocol. */
async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'wgb-card-'));
  spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let port = '';
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
  }
  if (!port) throw new Error('Chrome did not open a DevTools port');
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method: string, params = {}) => new Promise<any>((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = async (expression: string) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return m.result?.result?.value;
  };
  const open = async (file: string) => {
    await send('Page.navigate', { url: pathToFileURL(file).href });
    for (let i = 0; i < 300 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(100);
  };
  const close = async () => {
    ws.close();
    // Chrome can re-exec on macOS, leaving the spawned pid stale: kill by the throwaway profile dir.
    const owner = `user-data-dir=${profile}`;
    const running = () => { try { return !!execFileSync('pgrep', ['-f', owner]); } catch { return false; } };
    try { execFileSync('pkill', ['-f', owner]); } catch {}
    for (let i = 0; i < 50 && running(); i++) await sleep(100); // it writes to the profile until it exits
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, evaluate, open, close, profile };
}

/** Rows won per engine in every browser and backend, counted exactly as the report's scoreboard counts them. */
const WINS = `(() => {
  const views = [];
  for (const browser of browserNames) for (const backend of ['webgpu', 'webgl2']) {
    const wins = MAIN.map(() => 0);
    let rows = 0;
    for (const r of ROWS) {
      if (!r.backends.includes(backend)) continue;
      rows++;
      evalRow(r, browser, backend).entries.forEach((x, i) => { if (!x.st && !x.unranked && isWin(x)) wins[i]++; });
    }
    views.push({ browser, backend, rows, wins: Object.fromEntries(MAIN.map((e, i) => [e, wins[i]])) });
  }
  return { views, labels: Object.fromEntries(MAIN.map((e) => [e, ENG[e].label])) };
})()`;

const BACKEND: Record<string, string> = { webgpu: 'WebGPU', webgl2: 'WebGL2' };
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const both = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

function card(views: View[], labels: Record<string, string>) {
  const main = views.find((v) => v.browser === MAIN_VIEW.browser && v.backend === MAIN_VIEW.backend) ?? views[0];
  const ranked = Object.entries(main.wins).sort((a, b) => b[1] - a[1]);
  const order = ranked.filter(([, n]) => n > 0); // an engine without a win has no slice, but keeps its row in the list
  const total = order.reduce((a, [, n]) => a + n, 0);
  const leaders = (v: View) => Object.keys(v.wins).filter((e) => v.wins[e] === Math.max(...Object.values(v.wins)));
  const top = leaders(main);
  const where = `${main.browser} on ${BACKEND[main.backend]}`;
  const headline = top.length > 1 ? `${both(top.map((e) => labels[e]))} share the most wins` : `${labels[top[0]]} wins the most benchmarks`;
  const rest = views.filter((v) => v !== main);
  const sameLeader = top.length === 1 && rest.every((v) => leaders(v).join() === top[0]);
  const footer = sameLeader
    ? `Also first in ${rest.map((v) => `<b>${v.browser} ${BACKEND[v.backend]}</b> ${v.wins[top[0]]} of ${v.rows}`).join('<i>·</i>')}`
    : `Most wins elsewhere: ${rest.map((v) => `<b>${v.browser} ${BACKEND[v.backend]}</b> ${both(leaders(v).map((e) => labels[e]))}`).join('<i>·</i>')}`;

  // Logo centred on (x, y): icons `size` tall, the PixiJS wordmark `size` wide.
  const logo = (e: string, x: number, y: number, size: number) => {
    const L = ENG[e].logo;
    if ('img' in L) {
      const h = (size * L.h) / L.w;
      return `<image href="${L.img}" x="${x - size / 2}" y="${y - h / 2}" width="${size}" height="${h}"/>`;
    }
    return `<path d="${L.d}" fill="${ENG[e].ink}" transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})"/>`;
  };

  const cx = 400, cy = 400, R = 286;
  const pt = (a: number, r: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  let a0 = -Math.PI / 2;
  const slices = order.map(([e, n], i) => {
    const span = (n / total) * Math.PI * 2, a1 = a0 + span, mid = a0 + span / 2;
    const first = i === 0, r = first ? R + 16 : R, ink = ENG[e].ink;
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    const d = `M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${span > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`;
    const lift = first ? 30 : 0;
    const [lx, ly] = pt(mid, first ? r * 0.56 : r * 0.64);
    const size = first ? 210 : Math.min(64, Math.max(30, span * r * 0.45));
    const label = first
      ? `${logo(e, lx, ly - 34, size)}<text x="${lx}" y="${ly + 62}" class="sl big" fill="${ink}">${n} wins</text>`
      : e === 'babylon-lite' // shares Babylon.js's logo, so it names itself
        ? `${logo(e, lx, ly - size * 0.7, size)}<text x="${lx}" y="${ly + 16}" class="tag" fill="${ink}">LITE</text><text x="${lx}" y="${ly + size * 0.62 + 26}" class="sl" fill="${ink}">${n}</text>`
        : `${logo(e, lx, ly - size * 0.42, size)}<text x="${lx}" y="${ly + size * 0.62 + 6}" class="sl" fill="${ink}">${n}</text>`;
    const [bx, by] = pt(mid, r + 34);
    const badge = first ? `<circle cx="${bx}" cy="${by}" r="34" fill="#eef1ee"/><text x="${bx}" y="${by + 9}" class="b1">#1</text>` : '';
    a0 = a1;
    const g = `<g transform="translate(${(lift * Math.cos(mid)).toFixed(1)} ${(lift * Math.sin(mid)).toFixed(1)})"${first ? ' filter="url(#lift)"' : ''}><path d="${d}" fill="${ENG[e].color}" stroke="#0e100f" stroke-width="6" stroke-linejoin="round"/>${label}${badge}</g>`;
    return { first, g };
  });
  // The lifted slice draws last, over its neighbours' cut lines.
  const pie = [...slices.filter((s) => !s.first), ...slices.filter((s) => s.first)].map((s) => s.g).join('');

  const chip = (e: string, big: boolean) => {
    const L = ENG[e].logo, h = big ? 64 : 48, w = 'img' in L ? (big ? 132 : 96) : h;
    return `<svg class="chip" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${big ? 14 : 11}" fill="${ENG[e].color}"/>${logo(e, w / 2, h / 2, 'img' in L ? w - 22 : h * 0.56)}</svg>`;
  };
  const list = ranked.map(([e, n], i) => `<li class="${i === 0 ? 'first' : ''}"><span class="rank">${i + 1}</span>${chip(e, i === 0)}<span class="name">${labels[e]}</span><span class="n">${n}<small>${i === 0 ? ' wins' : ''}</small></span></li>`).join('');
  const engines = Object.keys(main.wins).length;

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,500..800&family=Onest:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=block">
<style>
  :root { --page: #0e100f; --surface: #161917; --ink: #eef1ee; --ink-2: #b6bdb8; --muted: #848b86; --hair: #262a27; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: var(--page); color: var(--ink); font-family: Onest, system-ui, sans-serif; overflow: hidden; }
  .card { position: relative; width: ${W}px; height: ${H}px; padding: 72px 84px 0; background: radial-gradient(640px 560px at 1150px 450px, ${ENG[order[0][0]].color}22, transparent 70%), var(--page); }
  .kicker { font: 500 15px/1 'JetBrains Mono', monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  h1 { margin: 22px 0 0; width: 640px; font: 800 66px/0.98 Archivo, sans-serif; font-stretch: 118%; letter-spacing: -0.02em; }
  .sub { margin: 20px 0 0; width: 600px; font-size: 19px; line-height: 1.45; color: var(--ink-2); }
  ol { list-style: none; margin: 34px 0 0; padding: 0; width: 600px; display: grid; gap: 8px; }
  li { display: grid; grid-template-columns: 28px auto 1fr auto; align-items: center; gap: 16px; padding: 7px 18px 7px 14px; border-radius: 14px; color: var(--ink-2); }
  li .rank { font: 500 17px/1 'JetBrains Mono', monospace; color: var(--muted); text-align: center; }
  li .name { font: 500 23px/1 Onest, sans-serif; }
  li .n { font: 700 30px/1 Archivo, sans-serif; font-stretch: 110%; color: var(--ink); font-variant-numeric: tabular-nums; }
  li .n small { font: 500 17px Onest, sans-serif; color: var(--ink-2); }
  li.first { padding: 14px 22px 14px 14px; background: var(--surface); box-shadow: inset 0 0 0 1.5px ${ENG[order[0][0]].color}99; margin-bottom: 6px; }
  li.first .rank { color: var(--ink); font-size: 20px; }
  li.first .name { font: 700 34px/1 Archivo, sans-serif; font-stretch: 112%; color: var(--ink); }
  li.first .n { font-size: 52px; }
  .chip { display: block; }
  .pie { position: absolute; left: 760px; top: 30px; width: 800px; height: 800px; overflow: visible; }
  .sl { font: 700 30px Archivo, sans-serif; font-stretch: 110%; text-anchor: middle; font-variant-numeric: tabular-nums; }
  .sl.big { font-size: 40px; }
  .tag { font: 600 16px 'JetBrains Mono', monospace; letter-spacing: .14em; text-anchor: middle; }
  .b1 { font: 800 27px Archivo, sans-serif; font-stretch: 112%; text-anchor: middle; fill: #121513; }
  footer { position: absolute; left: 84px; right: 84px; bottom: 34px; display: flex; justify-content: space-between; align-items: baseline; gap: 24px; font-size: 16px; color: var(--muted); border-top: 1px solid var(--hair); padding-top: 18px; }
  footer b { color: var(--ink-2); font-weight: 500; }
  footer i { font-style: normal; margin: 0 10px; color: #4a514c; }
  footer .url { font: 500 16px 'JetBrains Mono', monospace; color: var(--ink-2); }
</style>
<div class="card">
  <div class="kicker">${BACKEND[main.backend]} · ${WORDS[engines] ?? engines} web 3D engines · ${main.rows} benchmarks</div>
  <h1>${headline}</h1>
  <p class="sub">Benchmarks won in ${where}, out of ${main.rows}. A result within 5% of the best counts as a win for every engine that close, so wins add up to ${total}.</p>
  <ol>${list}</ol>
  <svg class="pie" viewBox="0 0 800 800" role="img" aria-label="Benchmarks won: ${order.map(([e, n]) => `${labels[e]} ${n}`).join(', ')}">
    <defs><filter id="lift" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".55"/></filter></defs>
    ${pie}
  </svg>
  <footer><span>${footer}</span><span class="url">endel.github.io/webgpu-webgl-benchmarks</span></footer>
</div>`;
}

if (!existsSync(REPORT)) throw new Error('no report/out/index.html: run `npm run report` first');
const chrome = await openChrome();
try {
  await chrome.open(REPORT);
  const { views, labels } = await chrome.evaluate(WINS);
  const page = join(chrome.profile, 'card.html');
  writeFileSync(page, card(views, labels));
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await chrome.open(page);
  await chrome.evaluate('document.fonts.ready.then(() => true)');
  const shot = await chrome.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  const main = views.find((v: View) => v.browser === MAIN_VIEW.browser && v.backend === MAIN_VIEW.backend) ?? views[0];
  console.log(`wrote ${OUT.slice(ROOT.length + 1)} (${W * SCALE}×${H * SCALE}): ${Object.entries(main.wins).map(([e, n]) => `${labels[e]} ${n}`).join(', ')} of ${main.rows} in ${main.browser} ${BACKEND[main.backend]}`);
} finally {
  await chrome.close();
}
