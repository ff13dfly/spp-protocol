/**
 * run-eval.mjs — multi-model perception eval for floor-plan reconstruction.
 *
 * For each labeled sample under samples/*.truth.json, run every model whose API
 * key is set through the perception pipeline, score the predicted layout against
 * the ground truth, and print a table + write a JSON report to results/.
 *
 *   node scripts/eval/run-eval.mjs                 # all samples × all keyed models
 *   node scripts/eval/run-eval.mjs --repeats=3     # average N runs/model (variance)
 *   node scripts/eval/run-eval.mjs --strict        # "Bedroom 1" ≠ "Bedroom" (default: lenient)
 *   node scripts/eval/run-eval.mjs --selftest      # offline: validate the scorer, no API calls
 *
 * Keys (env): ANTHROPIC_API_KEY, GEMINI_API_KEY|GOOGLE_API_KEY, QWEN_API_KEY|DASHSCOPE_API_KEY
 * Model ids (env, optional): CLAUDE_MODEL, GEMINI_MODEL, QWEN_MODEL
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPerception } from './perception.mjs';
import { availableModels, missingKeyNotes } from './providers.mjs';
import { scorePrediction } from './score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, 'samples');
const RESULTS = path.join(HERE, 'results');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const lenient = !has('--strict');                       // lenient by default (matches the prompt's "Bedroom 1/2")
const repeats = Math.max(1, parseInt((args.find(a => /^--repeats=\d+$/.test(a)) || '').split('=')[1] || '1', 10));
const pct = x => (x * 100).toFixed(1).padStart(5) + '%';

function loadSamples() {
  if (!fs.existsSync(SAMPLES)) return [];
  return fs.readdirSync(SAMPLES).filter(f => f.endsWith('.truth.json')).map(f => {
    const truth = JSON.parse(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
    truth._imagePath = path.resolve(SAMPLES, truth.image);
    return truth;
  });
}

const HEADLINE = ['roomF1', 'layoutAcc', 'builtAreaAcc', 'meanIoU', 'footprintIoU'];
const pick = s => ({ roomF1: s.rooms.f1, layoutAcc: s.layoutAcc, builtAreaAcc: s.builtAreaAcc, meanIoU: s.meanIoU, footprintIoU: s.footprintIoU });

function aggregate(scores) {
  const valid = scores.filter(s => s && s.valid);
  if (!valid.length) return { valid: false, reason: 'all runs invalid' };
  const mean = {}, stdev = {};
  for (const k of HEADLINE) {
    const xs = valid.map(s => pick(s)[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    mean[k] = m;
    stdev[k] = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }
  return { valid: true, runs: valid.length, ...mean, stdev, rooms: valid[0].rooms };
}

function fmtScore(a) {
  if (!a.valid) return `  invalid: ${a.reason}`;
  const base = `roomF1 ${pct(a.roomF1)} | layoutAcc ${pct(a.layoutAcc)} | builtAcc ${pct(a.builtAreaAcc)} | meanIoU ${pct(a.meanIoU)} | footprintIoU ${pct(a.footprintIoU)}`;
  return a.runs > 1 ? `${base}  (±${(a.stdev.meanIoU * 100).toFixed(1)} IoU, n=${a.runs})` : base;
}

// ── offline scorer self-test ─────────────────────────────────────────────────
function selftest() {
  const samples = loadSamples();
  if (!samples.length) { console.error('no samples to self-test'); process.exit(1); }
  const t = samples[0];
  console.log(`SELF-TEST on "${t.name}" (${t.gridZ}×${t.gridX})\n`);
  const sc = (pred, opts) => scorePrediction(pred, t.layout, opts);

  const perfect = sc(t.layout, { lenient });
  console.log('  identical → ~100% everywhere:\n   ', fmtScore(aggregate([perfect])));

  const swapped = t.layout.map(r => r.map(c => c === 'Kitchen' ? 'Bathroom' : c === 'Bathroom' ? 'Kitchen' : c));
  const swp = sc(swapped, { lenient });
  console.log('\n  kitchen/bathroom swapped → roomF1 holds, spatial drops:\n   ', fmtScore(aggregate([swp])));

  const halluc = t.layout.map(r => r.map(c => c == null ? null : 'Dining Room'));
  const hal = sc(halluc, { lenient });
  console.log('\n  all renamed to fabricated "Dining Room" → room/IoU crater, footprint holds:\n   ', fmtScore(aggregate([hal])));

  // lenient vs strict: rename every room to "<room> 1" — should match under lenient, miss under strict
  const numbered = t.layout.map(r => r.map(c => c == null ? null : `${c} 1`));
  const lenScore = sc(numbered, { lenient: true });
  const strScore = sc(numbered, { lenient: false });
  console.log(`\n  numbered rooms ("X 1") → lenient roomF1 ${pct(lenScore.rooms.f1)} vs strict roomF1 ${pct(strScore.rooms.f1)} (lenient must be higher)`);

  // empty prediction (all null)
  const empty = t.layout.map(r => r.map(() => null));
  const emptyScore = sc(empty, { lenient });
  console.log(`  empty prediction → roomF1 ${pct(emptyScore.rooms.f1)}, meanIoU ${pct(emptyScore.meanIoU)}, footprintIoU ${pct(emptyScore.footprintIoU)} (all ~0)`);

  const ok =
    perfect.layoutAcc > 0.99 && perfect.meanIoU > 0.99 && perfect.rooms.f1 > 0.99 && perfect.builtAreaAcc > 0.99 &&
    swp.layoutAcc < perfect.layoutAcc && swp.meanIoU < perfect.meanIoU && swp.rooms.f1 > 0.99 &&
    hal.rooms.f1 < 0.5 && hal.meanIoU < 0.2 && hal.footprintIoU > 0.99 &&
    lenScore.rooms.f1 > strScore.rooms.f1 && lenScore.rooms.f1 > 0.99 &&
    emptyScore.rooms.f1 === 0 && emptyScore.meanIoU === 0 && emptyScore.footprintIoU === 0;
  console.log('\n' + (ok ? 'SELF-TEST PASS ✓' : 'SELF-TEST FAIL ✗'));
  process.exit(ok ? 0 : 1);
}

// ── live run ─────────────────────────────────────────────────────────────────
async function main() {
  if (has('--selftest')) return selftest();

  const samples = loadSamples();
  if (!samples.length) { console.error(`no *.truth.json under ${SAMPLES}`); process.exit(1); }
  const models = availableModels();
  missingKeyNotes().forEach(n => console.log('⚠️  ' + n));
  if (!models.length) { console.error('\nNo API keys set — nothing to run. (Use --selftest to validate the scorer offline.)'); process.exit(1); }

  if (samples.length < 3)
    console.log(`⚠️  Only ${samples.length} sample(s) — indicative, not discriminating. Add labeled real plans (see README).`);
  if (samples.every(s => /synthetic|clean|easy/i.test(s.note || '')))
    console.log('⚠️  All samples look "easy" (clean/synthetic) — strong models near-ace this; not a capability discriminator.');

  console.log(`\nScoring: ${lenient ? 'lenient' : 'strict'} | repeats: ${repeats}\nModels: ${models.map(m => m.name).join(', ')}\nSamples: ${samples.map(s => s.name).join(', ')}\n`);

  const report = { startedAt: new Date().toISOString(), lenient, repeats, samples: [] };
  for (const t of samples) {
    console.log(`\n══ ${t.name} ══  (truth ${t.gridZ}×${t.gridX}, ${t.rooms.length} rooms)`);
    if (!fs.existsSync(t._imagePath)) { console.error(`  image not found: ${t._imagePath}`); continue; }
    const base64 = fs.readFileSync(t._imagePath).toString('base64');
    const mime = t._imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const aspect = (t.imageWidth || 1) / (t.imageHeight || 1);

    const perSample = { name: t.name, models: {} };
    for (const m of models) {
      process.stdout.write(`  ${m.name}: `);
      const runs = [];
      let lastPred = null, lastErr = null;
      for (let r = 0; r < repeats; r++) {
        try {
          const pred = await runPerception((sys, usr) => m.call(base64, mime, sys, usr), aspect);
          lastPred = pred;
          runs.push({ gridX: pred.gridX, gridZ: pred.gridZ, score: scorePrediction(pred.layout, t.layout, { lenient }) });
        } catch (err) { lastErr = err.message; }
      }
      const agg = aggregate(runs.map(r => r.score));
      if (!runs.length) {
        console.log(`ERROR ${lastErr}`);
        perSample.models[m.id] = { model: m.name, error: lastErr };
      } else {
        const g = lastPred ? `grid ${lastPred.gridZ}×${lastPred.gridX} | ` : '';
        console.log(g + fmtScore(agg) + (lastErr ? `  (${repeats - runs.length}/${repeats} runs failed: ${lastErr})` : ''));
        perSample.models[m.id] = { model: m.name, agg, runs, layout: lastPred?.layout, error: lastErr || undefined };
      }
    }
    report.samples.push(perSample);
  }

  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `eval-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n✅ report → ${path.relative(process.cwd(), out)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
