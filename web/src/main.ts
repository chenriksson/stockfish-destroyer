import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Color, Key } from '@lichess-org/chessground/types';
import { Chess, type Move } from 'chess.js';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

/** One entry of games/index.json (written by arena/play.py). Optional fields appeared in later engine versions. */
interface GameMeta {
  file: string;
  date: string;
  stockfish_elo: number;
  stockfish_version?: string;
  our_engine?: string;
  our_color: 'white' | 'black';
  result: string;
  outcome: 'win' | 'loss' | 'draw';
  plies: number;
  move_time_s?: number;
  engine_commit?: string;
  hardware?: string;
  adjudicated?: boolean;
}

interface Campaign {
  slots?: number[];
}

type ChipState = 'best' | 'beaten' | 'live' | 'attempted' | 'next' | 'locked' | 'none';

/** Elo reference levels from mission.md. Levels that appear in games or campaign slots are merged in. */
const LADDER = [1320, 1400, 1600, 1800, 2000, 2200, 2500];
const CHIP_LABEL: Record<ChipState, string> = {
  best: 'best win',
  beaten: 'beaten',
  live: 'in play',
  attempted: 'attempted',
  next: 'next',
  locked: 'locked',
  none: 'not played',
};
const SPEEDS = [0.5, 1, 2, 4];
const BASE_MS_PER_PLY = 700;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- state ----------
let games: GameMeta[] = [];
let current: GameMeta | undefined;
let history: Move[] = [];
let fens: string[] = [];
let ply = 0;
let timer: number | undefined;
let speedIdx = 1;
let orientation: Color = 'white';
let termination = '';

const cg: Api = Chessground($('#board'), {
  viewOnly: true,
  coordinates: false, // drawn outside the board by renderCoords()
  animation: { duration: 300 },
  highlight: { lastMove: true, check: true },
});

// ---------- formatting ----------
const fmtTime = (iso: string) => iso.slice(11, 16);
function fmtDate(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const moveCount = (plies: number) => Math.ceil(plies / 2);
function version(engine?: string) {
  const m = engine?.match(/\d+(\.\d+)+/);
  return m ? `v${m[0]}` : (engine ?? 'Destroyer');
}
const prettyTermination = (t: string) => cap(t.replace(/_/g, ' '));
function prettyResult(result: string) {
  if (result === '1/2-1/2') return '½ – ½';
  return result.replace(/^(\S+)-(\S+)$/, '$1 – $2');
}

// ---------- header: best win, Elo ladder, campaign ----------
function ladderStates(all: GameMeta[], slots: number[]): { elo: number; state: ChipState }[] {
  const wins = new Set(all.filter((g) => g.outcome === 'win').map((g) => g.stockfish_elo));
  const played = new Set(all.map((g) => g.stockfish_elo));
  const live = new Set(slots);
  const best = wins.size ? Math.max(...wins) : 0;
  const levels = [...new Set([...LADDER, ...played, ...live])].sort((a, b) => a - b);
  let nextTaken = false;
  return levels.map((elo) => {
    let state: ChipState;
    if (elo === best) state = 'best';
    else if (wins.has(elo)) state = 'beaten';
    else if (live.has(elo)) state = 'live';
    else if (played.has(elo)) state = 'attempted';
    else if (elo < best) state = 'none';
    else if (!nextTaken) {
      state = 'next';
      nextTaken = true;
    } else state = 'locked';
    return { elo, state };
  });
}

function renderHeader(all: GameMeta[], slots: number[]) {
  const wins = all.filter((g) => g.outcome === 'win');
  const best = wins.length ? Math.max(...wins.map((g) => g.stockfish_elo)) : undefined;
  $('#best-elo').textContent = best ? String(best) : '—';
  $('#best').classList.toggle('empty', !best);

  $('#ladder').innerHTML = ladderStates(all, slots)
    .map(
      ({ elo, state }) =>
        `<div class="chip ${state}" title="Stockfish Elo ${elo}: ${CHIP_LABEL[state]}"><span class="chip-elo">${elo}</span><span class="chip-label">${CHIP_LABEL[state]}</span></div>`,
    )
    .join('');

  const camp = $('#campaign');
  camp.innerHTML = slots.length
    ? `<span class="dot"></span><span>Campaign running · ${slots.length} slot${slots.length === 1 ? '' : 's'} · Elo ${slots.join(' · ')}</span>`
    : '';

  const latest = all[all.length - 1];
  if (latest?.our_engine) $('#brand-tag').textContent = `${version(latest.our_engine)} · Rust · ${latest.move_time_s ?? 5} s/move`;

  const counts = { win: 0, draw: 0, loss: 0 };
  all.forEach((g) => counts[g.outcome]++);
  $('#games-summary').textContent = all.length ? `${all.length} · ${counts.win} W · ${counts.draw} D · ${counts.loss} L` : '';
}

// ---------- game list ----------
function renderGameList() {
  const list = $('#game-list');
  list.innerHTML = '';
  if (!games.length) {
    list.innerHTML = '<p class="empty-note">No games yet. Run <code>uv run arena --elo 1320</code> and refresh.</p>';
    return;
  }
  let lastDay = '';
  for (const g of [...games].reverse()) {
    const day = g.date.slice(0, 10);
    if (day !== lastDay) {
      list.insertAdjacentHTML('beforeend', `<div class="day">${esc(fmtDate(g.date))}</div>`);
      lastDay = day;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'game';
    btn.dataset.file = g.file;
    btn.innerHTML = `<span class="pill ${g.outcome}">${g.outcome.toUpperCase()}</span>
      <span class="game-main">
        <span class="game-title">vs Stockfish <span class="mono">${g.stockfish_elo}</span></span>
        <span class="game-meta">${esc(version(g.our_engine))} · ${moveCount(g.plies)} moves · ${g.our_color}</span>
      </span>
      <span class="game-time mono">${esc(fmtTime(g.date))}</span>`;
    btn.onclick = () => void loadGame(g);
    list.append(btn);
  }
}

// ---------- one game ----------
async function loadGame(meta: GameMeta) {
  stop();
  current = meta;
  document
    .querySelectorAll<HTMLElement>('#game-list .game')
    .forEach((el) => el.classList.toggle('active', el.dataset.file === meta.file));

  try {
    const res = await fetch(`/${meta.file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pgn = await res.text();
    const chess = new Chess();
    chess.loadPgn(pgn);
    history = chess.history({ verbose: true });
    fens = [history[0]?.before ?? new Chess().fen(), ...history.map((m) => m.after)];
    termination = pgn.match(/\[Termination "([^"]*)"\]/)?.[1] ?? '';
  } catch (err) {
    console.error(`Could not load ${meta.file}`, err);
    history = [];
    fens = [new Chess().fen()];
    termination = '';
  }

  orientation = meta.our_color;
  cg.set({ orientation });
  renderCoords();
  renderMatch(meta);
  renderBanner(meta);
  renderVerify(meta);
  renderMoves();
  $<HTMLInputElement>('#scrubber').max = String(history.length);
  $('#ply-count').textContent = `${history.length} plies`;
  document.title = `Destroyer vs Stockfish ${meta.stockfish_elo} · ${meta.result}`;
  show(0);
}

function renderMatch(meta: GameMeta) {
  const us = meta.our_engine ?? 'Destroyer';
  const sf = `${meta.stockfish_version ?? 'Stockfish'} · Elo ${meta.stockfish_elo}`;
  $('#p-white').textContent = meta.our_color === 'white' ? us : sf;
  $('#p-black').textContent = meta.our_color === 'white' ? sf : us;
  const score = $('#score');
  score.textContent = prettyResult(meta.result);
  score.className = `score ${meta.outcome}`;

  const parts = [
    termination ? prettyTermination(termination) : meta.adjudicated ? 'Adjudicated' : '',
    `${moveCount(meta.plies)} moves`,
    `${fmtDate(meta.date)}, ${fmtTime(meta.date)}`,
    `UCI_LimitStrength · UCI_Elo ${meta.stockfish_elo}`,
  ].filter(Boolean);
  $('#match-meta').innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="sep">·</span>');
  $('#match').hidden = false;
}

function renderBanner(meta: GameMeta) {
  const us = meta.our_engine ?? 'Destroyer';
  const sf = meta.stockfish_version ?? 'Stockfish';
  const isMate = termination.toLowerCase() === 'checkmate';
  const title = meta.outcome === 'win' ? (isMate ? 'Checkmate' : 'Victory') : meta.outcome === 'loss' ? 'Defeat' : 'Draw';
  const who =
    meta.outcome === 'win'
      ? `${us} beats ${sf} at Elo ${meta.stockfish_elo}`
      : meta.outcome === 'loss'
        ? `${sf} (Elo ${meta.stockfish_elo}) beats ${us}`
        : `${us} draws ${sf} at Elo ${meta.stockfish_elo}`;
  const last = history[history.length - 1];
  const lastSan = last ? `${moveCount(history.length)}.${history.length % 2 === 0 ? '..' : ''} ${last.san}` : '';
  const term = termination && !isMate ? prettyTermination(termination) : '';
  $('#banner-title').textContent = title;
  $('#banner-sub').textContent = [who, term, lastSan].filter(Boolean).join(' · ');
  $('#banner').className = `banner ${meta.outcome}`;
}

function renderVerify(meta: GameMeta) {
  const rows: [string, string][] = [
    ['Opponent', meta.stockfish_version ?? 'Stockfish'],
    ['UCI_Elo', `${meta.stockfish_elo} · LimitStrength on`],
    ['Move time', `${meta.move_time_s ?? '?'} s / move`],
    ['Engine', [meta.our_engine, meta.engine_commit].filter(Boolean).join(' · ') || 'Destroyer'],
    ['Hardware', meta.hardware ?? '—'],
    ['Result', `${meta.result}${meta.adjudicated ? ' · adjudicated' : ''}`],
  ];
  $('#verify-list').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const link = $<HTMLAnchorElement>('#pgn-link');
  link.href = `/${meta.file}`;
  link.download = meta.file;
  $('#verify').hidden = false;
}

function renderMoves() {
  const box = $('#moves');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<p class="empty-note">No moves to show.</p>';
    return;
  }
  history.forEach((m, i) => {
    if (i % 2 === 0) box.insertAdjacentHTML('beforeend', `<span class="num">${i / 2 + 1}.</span>`);
    const el = document.createElement('span');
    el.className = 'ply';
    el.textContent = m.san;
    el.title = `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '...'} ${m.san}`;
    el.onclick = () => {
      stop();
      show(i + 1);
    };
    box.append(el);
  });
}

function renderCoords() {
  const ranks = orientation === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = (orientation === 'white' ? 'abcdefgh' : 'hgfedcba').split('');
  $('#ranks').innerHTML = ranks.map((r) => `<span>${r}</span>`).join('');
  $('#files').innerHTML = files.map((f) => `<span>${f}</span>`).join('');
}

// ---------- position / playback ----------
function turnLabel() {
  if (!history.length) return '';
  if (ply === history.length) {
    const t = termination ? prettyTermination(termination) : (current?.result ?? '');
    return `Game over · ${t}`;
  }
  return `Move ${Math.floor(ply / 2) + 1} · ${ply % 2 === 0 ? 'White' : 'Black'} to move`;
}

function show(n: number) {
  ply = Math.max(0, Math.min(n, history.length));
  const last = history[ply - 1];
  cg.set({
    fen: fens[ply],
    lastMove: last ? [last.from as Key, last.to as Key] : undefined,
    check: !!last && (last.san.includes('+') || last.san.includes('#')),
    turnColor: ply % 2 === 0 ? 'white' : 'black',
  });

  const plies = document.querySelectorAll<HTMLElement>('#moves .ply');
  plies.forEach((el, i) => el.classList.toggle('current', i === ply - 1));
  plies[ply - 1]?.scrollIntoView({ block: 'nearest' });

  const scrub = $<HTMLInputElement>('#scrubber');
  scrub.value = String(ply);
  scrub.style.setProperty('--p', `${history.length ? (ply / history.length) * 100 : 0}%`);
  $('#ply-label').textContent = `Ply ${ply} / ${history.length}`;
  $('#turn-label').textContent = turnLabel();

  const atEnd = history.length > 0 && ply === history.length;
  $('#banner').classList.toggle('show', atEnd);
  if (atEnd) stop();
}

function stop() {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  const play = $('#play');
  play.classList.remove('playing');
  play.setAttribute('aria-label', 'Play');
}

function play() {
  if (!history.length) return;
  if (ply >= history.length) show(0);
  timer = window.setInterval(() => (ply >= history.length ? stop() : show(ply + 1)), BASE_MS_PER_PLY / SPEEDS[speedIdx]);
  const btn = $('#play');
  btn.classList.add('playing');
  btn.setAttribute('aria-label', 'Pause');
}

function step(action: string) {
  if (action === 'play') {
    if (timer !== undefined) stop();
    else play();
    return;
  }
  stop();
  if (action === 'first') show(0);
  if (action === 'prev') show(ply - 1);
  if (action === 'next') show(ply + 1);
  if (action === 'last') show(history.length);
}

function cycleSpeed() {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $('#speed').textContent = `${SPEEDS[speedIdx]}×`;
  if (timer !== undefined) {
    stop();
    play();
  }
}

function flip() {
  orientation = orientation === 'white' ? 'black' : 'white';
  cg.set({ orientation });
  renderCoords();
}

// ---------- wiring ----------
document.querySelectorAll<HTMLButtonElement>('#controls button[data-step]').forEach((b) => (b.onclick = () => step(b.dataset.step!)));
$('#speed').onclick = cycleSpeed;
$('#flip').onclick = flip;
$<HTMLInputElement>('#scrubber').oninput = (e) => {
  stop();
  show(Number((e.target as HTMLInputElement).value));
};
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const map: Record<string, string> = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last', ' ': 'play' };
  if (map[e.key]) {
    e.preventDefault();
    step(map[e.key]);
  } else if (e.key === 'f' || e.key === 'F') {
    flip();
  }
});

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined; // dev server returns index.html for missing files; JSON parse fails → treat as absent
  }
}

async function init() {
  const [index, campaign] = await Promise.all([fetchJson<GameMeta[]>('/index.json'), fetchJson<Campaign>('/campaign.json')]);
  games = Array.isArray(index) ? index : [];
  games.sort((a, b) => a.date.localeCompare(b.date));
  const rawSlots = campaign?.slots;
  const slots = Array.isArray(rawSlots) ? rawSlots.filter((n) => typeof n === 'number') : [];

  renderHeader(games, slots);
  renderGameList();
  renderCoords();

  // Open the proof game (highest Elo win) first; fall back to the latest game.
  const bestWin = games
    .filter((g) => g.outcome === 'win')
    .sort((a, b) => b.stockfish_elo - a.stockfish_elo || b.date.localeCompare(a.date))[0];
  const first = bestWin ?? games[games.length - 1];
  if (first) await loadGame(first);
}

void init();
