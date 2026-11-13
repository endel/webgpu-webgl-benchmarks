import { ENGINES, SCENARIOS, engineSupports } from './matrix';
import { toSearch } from './params';

// Landing page. With ?session= (set by the runner) it hands off to the first queued run;
// otherwise it lists standalone links for manual inspection.

const q = new URLSearchParams(location.search);
const session = q.get('session');

if (session) {
  document.getElementById('status')!.textContent = `Starting session ${session}…`;
  fetch(`/api/next?session=${encodeURIComponent(session)}&gen=${encodeURIComponent(q.get('gen') ?? '')}`)
    .then((r) => r.json())
    .then((j) => {
      if (j.url) location.replace(j.url);
      else document.getElementById('status')!.textContent = 'Session complete.';
    });
} else {
  const table = document.getElementById('t') as HTMLTableElement;
  for (const s of SCENARIOS) {
    for (const variant of s.variants) {
      for (const backend of s.backends) {
        const row = table.insertRow();
        row.insertCell().textContent = `${s.id} ${s.title}`;
        row.insertCell().textContent = `${variant} / ${backend}`;
        const cell = row.insertCell();
        for (const engine of ENGINES) {
          if (!engineSupports(engine, backend)) continue;
          const a = document.createElement('a');
          a.href = `bench.html?${toSearch({ engine, backend, scenario: s.id, variant, level: (s.levelsFor?.[variant] ?? s.levels)[s.id === 'k4' ? 3 : s.id === 'k9' ? 3 : 0], standalone: true })}`;
          a.textContent = engine;
          cell.append(a, ' ');
        }
      }
    }
  }
}
