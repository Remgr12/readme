'use strict';

const https   = require('https');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const fontkit = require('fontkit');

// ── Config ─────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME;

const CUSTOM = {
  stack:    process.env.WIDGET_STACK    || '',
  learning: process.env.WIDGET_LEARNING || '',
  other:    process.env.WIDGET_OTHER    || '',
  contact:  process.env.WIDGET_CONTACT  || '',
  location: process.env.WIDGET_LOCATION || '',
};

const MAX_LANGS   = 5;
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? 'github-stats.svg';

// ── Font (joshpuckett/allo variable font → SVG paths via fontkit) ──────────────
const ALLO_URL   = 'https://raw.githubusercontent.com/joshpuckett/allo/main/fonts/variable/AlloVariable.ttf';
const ALLO_CACHE = process.env.WIDGET_FONT_PATH || path.join(os.tmpdir(), 'AlloVariable.ttf');
const ALLO_AXES  = {
  body:  { wght: 550, ROND: 100, opsz: 16 },
  label: { wght: 650, ROND: 100, opsz: 16 },
  stat:  { wght: 720, ROND: 100, opsz: 16 },
};

// ── Themes ─────────────────────────────────────────────────────────────────────
// Select via WIDGET_THEME env var: 'default' | 'nord' | 'catppuccin'
const THEMES = {
  default: {
    card:        '#0d1117',
    chipBg:      '#111827',
    chipBorder:  '#1f2937',
    pillBg:      '#1e293b',
    pillBorder:  '#334155',
    labelText:   '#94A3B8',
    valueText:   '#ECEFF4',
    mutedText:   '#94A3B8',
    timestamp:   '#64748B',
    accent:      '#38bdf8',
    dotColor:    '#ffffff',
    dotOpacity:  0.05,
    accentStops: ['#22d3ee', '#38bdf8', '#0ea5e9'],
    borderStops: [
      { color: '#38bdf8', opacity: 0.45 },
      { color: '#334155', opacity: 0.35 },
      { color: '#22d3ee', opacity: 0.45 },
    ],
  },

  nord: {
    card:        '#2e3440',
    chipBg:      '#3b4252',
    chipBorder:  '#4c566a',
    pillBg:      '#434c5e',
    pillBorder:  '#546077',
    labelText:   '#94A3B8',
    valueText:   '#ECEFF4',
    mutedText:   '#94A3B8',
    timestamp:   '#7F849C',
    accent:      '#88c0d0',
    dotColor:    '#eceff4',
    dotOpacity:  0.04,
    accentStops: ['#8fbcbb', '#88c0d0', '#81a1c1'],
    borderStops: [
      { color: '#88c0d0', opacity: 0.55 },
      { color: '#4c566a', opacity: 0.40 },
      { color: '#81a1c1', opacity: 0.50 },
    ],
  },

  catppuccin: {
    card:        '#1e1e2e',
    chipBg:      '#313244',
    chipBorder:  '#45475a',
    pillBg:      '#3b3d52',
    pillBorder:  '#585b70',
    labelText:   '#7F849C',
    valueText:   '#CDD6F4',
    mutedText:   '#7F849C',
    timestamp:   '#6c7086',
    accent:      '#89dceb',
    dotColor:    '#cdd6f4',
    dotOpacity:  0.04,
    accentStops: ['#94e2d5', '#89dceb', '#74c7ec'],
    borderStops: [
      { color: '#89dceb', opacity: 0.55 },
      { color: '#45475a', opacity: 0.35 },
      { color: '#94e2d5', opacity: 0.55 },
    ],
  },
};

const activeTheme =
  THEMES[(process.env.WIDGET_THEME ?? 'default').toLowerCase()] ?? THEMES.default;

// ── Language colors (GitHub-style) ────────────────────────────────────────────
const LANG_COLORS = {
  JavaScript:  '#f1e05a',  TypeScript:  '#3178c6',  Python:   '#3572A5',
  Rust:        '#dea584',  Go:          '#00ADD8',  Java:     '#b07219',
  'C++':       '#f34b7d',  C:           '#555555',  Ruby:     '#701516',
  Swift:       '#F05138',  Kotlin:      '#A97BFF',  PHP:      '#4F5D95',
  CSS:         '#563d7c',  HTML:        '#e34c26',  Shell:    '#89e051',
  Nix:         '#7e7eff',  Lua:         '#000080',  Haskell:  '#5e5086',
  Elixir:      '#6e4a7e',  Scala:       '#c22d40',  Dart:     '#00B4AB',
  Vue:         '#41b883',  Svelte:      '#ff3e00',  Zig:      '#ec915c',
  'C#':        '#178600',  PowerShell:  '#012456',  Makefile: '#427819',
};
const langColor = (name) => LANG_COLORS[name] ?? '#8b949e';

// ── HTTP primitives ────────────────────────────────────────────────────────────
function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects downloading font'));
    https.get(url, { headers: { 'User-Agent': 'github-stats-widget/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Font download HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(dest, Buffer.concat(chunks));
        resolve(dest);
      });
    }).on('error', reject);
  });
}

async function loadAlloFont(fontPath = ALLO_CACHE) {
  if (!fs.existsSync(fontPath)) {
    console.log(`[widget] downloading AlloVariable.ttf → ${fontPath}`);
    await downloadFile(ALLO_URL, fontPath);
  }
  const base = fontkit.openSync(fontPath);
  return {
    body:  base.getVariation(ALLO_AXES.body),
    label: base.getVariation(ALLO_AXES.label),
    stat:  base.getVariation(ALLO_AXES.stat),
  };
}

// ── Text-to-SVG path helpers ──────────────────────────────────────────────────
const r2 = (n) => Math.round(n * 100) / 100;

function measureText(font, text, fontSize, letterSpacing = 0) {
  const run   = font.layout(String(text));
  const scale = fontSize / font.unitsPerEm;
  const extra = Math.max(0, run.glyphs.length - 1) * letterSpacing;
  return run.advanceWidth * scale + extra;
}

function textToPath(font, text, { x, y, fontSize, anchor = 'start', letterSpacing = 0, fill }) {
  const str    = String(text);
  const run    = font.layout(str);
  const scale  = fontSize / font.unitsPerEm;
  const totalW = run.advanceWidth * scale + Math.max(0, run.glyphs.length - 1) * letterSpacing;

  let cursorX = x;
  if (anchor === 'middle') cursorX -= totalW / 2;
  else if (anchor === 'end') cursorX -= totalW;

  const parts = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const pos   = run.positions[i];
    const gx    = cursorX + pos.xOffset * scale;
    const gy    = y - pos.yOffset * scale;

    for (const cmd of glyph.path.commands) {
      const a = cmd.args;
      switch (cmd.command) {
        case 'moveTo':
          parts.push(`M${r2(gx + a[0] * scale)} ${r2(gy - a[1] * scale)}`);
          break;
        case 'lineTo':
          parts.push(`L${r2(gx + a[0] * scale)} ${r2(gy - a[1] * scale)}`);
          break;
        case 'quadraticCurveTo':
          parts.push(`Q${r2(gx + a[0] * scale)} ${r2(gy - a[1] * scale)} ${r2(gx + a[2] * scale)} ${r2(gy - a[3] * scale)}`);
          break;
        case 'bezierCurveTo':
          parts.push(`C${r2(gx + a[0] * scale)} ${r2(gy - a[1] * scale)} ${r2(gx + a[2] * scale)} ${r2(gy - a[3] * scale)} ${r2(gx + a[4] * scale)} ${r2(gy - a[5] * scale)}`);
          break;
        case 'closePath':
          parts.push('Z');
          break;
      }
    }
    cursorX += pos.xAdvance * scale + letterSpacing;
  }

  if (!parts.length) return '';
  return `<path d="${parts.join('')}" fill="${fill}"/>`;
}

async function gqlRequest(query, variables = {}) {
  const payload = JSON.stringify({ query, variables });
  const res = await rawRequest({
    hostname: 'api.github.com',
    path:     '/graphql',
    method:   'POST',
    headers: {
      Authorization:    `bearer ${TOKEN}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent':     'github-stats-widget/1.0',
    },
  }, payload);
  if (res.status >= 400) throw new Error(`GraphQL HTTP ${res.status}: ${res.body}`);
  const json = JSON.parse(res.body);
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// REST contributor stats with automatic 202 retry
async function fetchContributorStats(nameWithOwner, attempt = 0) {
  const res = await rawRequest({
    hostname: 'api.github.com',
    path:     `/repos/${nameWithOwner}/stats/contributors`,
    method:   'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent':  'github-stats-widget/1.0',
      Accept:        'application/vnd.github+json',
    },
  });
  if (res.status === 202 && attempt < 6) {
    await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
    return fetchContributorStats(nameWithOwner, attempt + 1);
  }
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// ── Data: personal repos (paginated) ─────────────────────────────────────────
async function fetchPersonalRepos(after = null, acc = []) {
  const data = await gqlRequest(`
    query($login: String!, $after: String) {
      user(login: $login) {
        createdAt
        publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) {
          totalCount
        }
        repositories(
          first: 100
          ownerAffiliations: OWNER
          after: $after
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            nameWithOwner
            isFork
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `, { login: USERNAME, after });

  const user = data.user;
  acc.push(...user.repositories.nodes);

  if (user.repositories.pageInfo.hasNextPage) {
    return fetchPersonalRepos(user.repositories.pageInfo.endCursor, acc);
  }
  return {
    createdAt:   user.createdAt,
    publicRepos: user.publicRepos.totalCount,
    repos:       acc,
  };
}

// ── Data: repos from a single org (paginated) ────────────────────────────────
async function fetchOrgRepos(orgLogin, after = null, acc = []) {
  const data = await gqlRequest(`
    query($org: String!, $after: String) {
      organization(login: $org) {
        repositories(
          first: 100
          after: $after
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            nameWithOwner
            isFork
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `, { org: orgLogin, after });

  acc.push(...data.organization.repositories.nodes);

  if (data.organization.repositories.pageInfo.hasNextPage) {
    return fetchOrgRepos(orgLogin, data.organization.repositories.pageInfo.endCursor, acc);
  }
  return acc;
}

// ── Data: all orgs the user belongs to ───────────────────────────────────────
async function fetchUserOrgs() {
  const data = await gqlRequest(`
    query($login: String!) {
      user(login: $login) {
        organizations(first: 100) {
          nodes { login }
        }
      }
    }
  `, { login: USERNAME });
  return data.user.organizations.nodes.map((o) => o.login);
}

// ── Data: all repos — personal + all orgs ────────────────────────────────────
async function fetchAllRepos() {
  const [{ createdAt, publicRepos, repos: personalRepos }, orgs] = await Promise.all([
    fetchPersonalRepos(),
    fetchUserOrgs(),
  ]);

  console.log(`[widget] ${personalRepos.length} personal repos (${publicRepos} public), ${orgs.length} org(s): ${orgs.join(', ') || 'none'}`);

  const orgRepoLists = await Promise.allSettled(orgs.map((org) => fetchOrgRepos(org)));
  const orgRepos = orgRepoLists
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Deduplicate by nameWithOwner in case of overlap
  const seen = new Set();
  const allRepos = [...personalRepos, ...orgRepos].filter((r) => {
    if (seen.has(r.nameWithOwner)) return false;
    seen.add(r.nameWithOwner);
    return true;
  });

  return { createdAt, publicRepos, repos: allRepos };
}

// ── Data: contributions within a date window ──────────────────────────────────
async function fetchContributions(from, to) {
  const data = await gqlRequest(`
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar { totalContributions }
        }
      }
    }
  `, { login: USERNAME, from, to });
  return data.user.contributionsCollection.contributionCalendar.totalContributions;
}

async function fetchLifetimeContribs(createdAt) {
  const now         = new Date();
  const createdYear = new Date(createdAt).getFullYear();
  const thisYear    = now.getFullYear();
  let total = 0;
  for (let y = createdYear; y <= thisYear; y++) {
    const from = new Date(`${y}-01-01T00:00:00Z`).toISOString();
    const to   = y < thisYear
      ? new Date(`${y}-12-31T23:59:59Z`).toISOString()
      : now.toISOString();
    total += await fetchContributions(from, to);
  }
  return total;
}

// ── Data: lines of code (additions across ALL owned repos) ───────────────────
// Uses additions only (not +deletions) to avoid double-counting rewrites.
// Batched to avoid flooding the stats endpoint, which returns 202 when stats
// aren't cached — flooding causes most repos to never finish computing in time.
async function fetchLinesOfCode(repos) {
  const BATCH_SIZE = 15;
  let total  = 0;
  let missed = 0;

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (repo) => {
        const stats = await fetchContributorStats(repo.nameWithOwner);
        if (!Array.isArray(stats)) return 0;
        const mine = stats.find(
          (s) => s.author?.login?.toLowerCase() === USERNAME.toLowerCase(),
        );
        return mine ? mine.weeks.reduce((s, w) => s + w.a, 0) : 0;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') total += r.value;
      else missed++;
    }
    if (i + BATCH_SIZE < repos.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (missed > 0) console.warn(`[widget] LOC: ${missed} repo(s) failed entirely`);
  return total;
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatYears(createdAt, now = Date.now()) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const years = Math.max(0, (now - new Date(createdAt).getTime()) / msPerYear);
  return years >= 10 ? String(Math.floor(years)) : years.toFixed(1);
}

// ── Pill & text layout helpers (exact font metrics) ───────────────────────────
function parsePills(raw) {
  return String(raw || '')
    .split(/\s*[·,\n]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function layoutPills(font, items, maxWidth) {
  const PILL_H     = 24;
  const PILL_PAD_X = 11;
  const GAP_X      = 7;
  const GAP_Y      = 7;
  const FONT_SIZE  = 12;

  const placed = [];
  let cx = 0;
  let cy = 0;

  for (const label of items) {
    const textW = measureText(font, label, FONT_SIZE);
    const w = Math.min(maxWidth, Math.ceil(textW) + PILL_PAD_X * 2);
    if (cx > 0 && cx + w > maxWidth) {
      cx = 0;
      cy += PILL_H + GAP_Y;
    }
    placed.push({ label, x: cx, y: cy, w, h: PILL_H, fontSize: FONT_SIZE });
    cx += w + GAP_X;
  }

  const height = placed.length ? cy + PILL_H : 0;
  return { placed, height };
}

function wrapText(font, text, availWidth, fontSize) {
  const rawLines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const out = [];
  for (const line of rawLines) {
    if (measureText(font, line, fontSize) <= availWidth) {
      out.push(line);
      continue;
    }
    const tokens = line.split(/\s+/);
    let cur = '';
    for (const tok of tokens) {
      const cand = cur ? `${cur} ${tok}` : tok;
      if (measureText(font, cand, fontSize) <= availWidth) { cur = cand; }
      else { if (cur) out.push(cur); cur = tok; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// ── Icons (16 × 16 octicon paths) ─────────────────────────────────────────────
const ICON = {
  repo:     `<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>`,
  commit:   `<path d="M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5H4.07a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5zm-1.43-.75a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z"/>`,
  calendar: `<path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"/>`,
  code:     `<path d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z"/>`,
  layers:   `<rect x="1.5" y="1.5"  width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.4"/><rect x="1.5" y="6.25" width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.7"/><rect x="1.5" y="11"   width="13" height="3.5" rx="1.75" fill="currentColor"/>`,
  book:     `<path d="M1 2.5A2.5 2.5 0 013.5 0h9.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 000 2h.75a.75.75 0 010 1.5H3.5A2.5 2.5 0 011 11.5zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1z"/>`,
  other:    `<path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h4.586a1.5 1.5 0 0 1 1.06.44l6.5 6.5a1.5 1.5 0 0 1 0 2.12l-4.586 4.585a1.5 1.5 0 0 1-2.12 0l-6.5-6.5A1.5 1.5 0 0 1 1 7.085zm3.5 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>`,
  mail:     `<path d="M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm12.5 1.5H1.75a.25.25 0 0 0-.25.25v.32l6.5 4.5 6.5-4.5v-.32a.25.25 0 0 0-.25-.25ZM1.5 5.809v6.442c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V5.809l-6.5 4.5Z"/>`,
  location: `<path d="M8 0a6.5 6.5 0 0 1 6.5 6.5c0 4.673-4.996 9.68-6.136 10.74a.5.5 0 0 1-.728 0C6.496 16.18 1.5 11.173 1.5 6.5A6.5 6.5 0 0 1 8 0Zm0 1.5a5 5 0 0 0-5 5c0 3.398 3.55 7.42 5 8.89 1.45-1.47 5-5.492 5-8.89a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/>`,
};

// ── SVG builder ────────────────────────────────────────────────────────────────
function buildSVG({ publicRepos, lifetimeContribs, yearsOnGithub, linesOfCode, languages, font, custom = CUSTOM, theme = activeTheme }) {
  const F      = font.body ? font : { body: font, label: font, stat: font };
  const T      = theme;
  const W      = 856;
  const PAD    = 24;
  const RADIUS = 14;
  const GAP    = 12;

  const langs   = languages.slice(0, MAX_LANGS);
  const totalSz = langs.reduce((s, l) => s + l.size, 0) || 1;

  // ── Stat chips — 4 across ───────────────────────────────────────────────────
  const CHIP_W     = Math.floor((W - PAD * 2 - GAP * 3) / 4);
  const CHIP_H     = 84;
  const CHIPS_Y    = 20;
  const chipStartX = Math.round((W - (CHIP_W * 4 + GAP * 3)) / 2);
  const chipXs     = [0, 1, 2, 3].map((i) => chipStartX + i * (CHIP_W + GAP));

  const statsData = [
    { label: 'PUBLIC REPOS',     value: fmt(publicRepos),      icon: ICON.repo     },
    { label: 'LIFETIME COMMITS', value: fmt(lifetimeContribs), icon: ICON.commit   },
    { label: 'YEARS ON GITHUB',  value: String(yearsOnGithub), icon: ICON.calendar },
    { label: 'LINES OF CODE',    value: fmt(linesOfCode),      icon: ICON.code     },
  ];

  const chipsHtml = statsData.map((s, i) => {
    const x  = chipXs[i];
    const cx = x + Math.round(CHIP_W / 2);
    return `
  <rect x="${x}" y="${CHIPS_Y}" width="${CHIP_W}" height="${CHIP_H}" rx="10" ry="10"
        fill="${T.chipBg}" stroke="${T.chipBorder}" stroke-width="1"/>
  <g transform="translate(${cx - 8},${CHIPS_Y + 11})" fill="${T.accent}">${s.icon}</g>
  ${textToPath(F.label, s.label, { x: cx, y: CHIPS_Y + 46, fontSize: 10.5, anchor: 'middle', letterSpacing: 0.8, fill: T.labelText })}
  ${textToPath(F.stat, s.value, { x: cx, y: CHIPS_Y + 71, fontSize: 22, anchor: 'middle', fill: T.valueText })}`;
  }).join('');

  // ── Language section ────────────────────────────────────────────────────────
  const BAR_X       = PAD;
  const BAR_W       = W - PAD * 2;
  const LANG_TOP    = CHIPS_Y + CHIP_H + 26;
  const SEGBAR_Y    = LANG_TOP + 10;
  const SEGBAR_H    = 10;
  const LEGEND_Y    = SEGBAR_Y + SEGBAR_H + 16;
  const LEGEND_ROW  = 22;
  const LEGEND_ROWS = Math.ceil(langs.length / 2);

  let runX = BAR_X;
  const segments = langs.map((l, i) => {
    const isLast = i === langs.length - 1;
    const sw = isLast
      ? (BAR_X + BAR_W - runX)
      : Math.round(BAR_W * l.size / totalSz);
    const seg = `<rect x="${runX}" y="${SEGBAR_Y}" width="${sw}" height="${SEGBAR_H}" fill="${langColor(l.name)}"/>`;
    runX += sw;
    return seg;
  }).join('');

  // Align 2-column language legend with the 2-column Bento grid below
  const BENTO_COL_W = Math.floor((W - PAD * 2 - GAP) / 2);
  const legend = langs.map((l, i) => {
    const col  = i % 2;
    const row  = Math.floor(i / 2);
    const colX = PAD + col * (BENTO_COL_W + GAP);
    const y    = LEGEND_Y + row * LEGEND_ROW;
    const pct  = (l.size / totalSz * 100).toFixed(1) + '%';
    const name = l.name.length > 20 ? `${l.name.slice(0, 19)}…` : l.name;
    return `
  <circle cx="${colX + 5}" cy="${y + 5}" r="4.5" fill="${langColor(l.name)}"/>
  ${textToPath(F.body, name, { x: colX + 16, y: y + 9, fontSize: 13, fill: T.valueText })}
  ${textToPath(F.body, pct, { x: colX + BENTO_COL_W, y: y + 9, fontSize: 12.5, anchor: 'end', fill: T.mutedText })}`;
  }).join('');

  // ── 2-Column Bento-Box Grid ─────────────────────────────────────────────────
  const BENTO_Y      = LEGEND_Y + LEGEND_ROWS * LEGEND_ROW + 14;
  const CARD_PAD_X   = 16;
  const CARD_PAD_TOP = 14;
  const CARD_PAD_BOT = 16;
  const HEADER_H     = 16;
  const CONTENT_GAP  = 12;
  const TEXT_SIZE    = 13.5;
  const TEXT_LINE_H  = 20;
  const CARD_INNER_W = BENTO_COL_W - CARD_PAD_X * 2;

  function buildCardModel(def) {
    if (def.type === 'pills') {
      const items = parsePills(def.value);
      if (!items.length) return null;
      const layout = layoutPills(F.body, items, CARD_INNER_W);
      const minH   = CARD_PAD_TOP + HEADER_H + CONTENT_GAP + layout.height + CARD_PAD_BOT;
      return { ...def, layout, height: minH };
    }
    const lines = wrapText(F.body, def.value, CARD_INNER_W, TEXT_SIZE);
    if (!lines.length) return null;
    const minH = CARD_PAD_TOP + HEADER_H + CONTENT_GAP + lines.length * TEXT_LINE_H + CARD_PAD_BOT - 2;
    return { ...def, lines, height: minH };
  }

  const leftCards = [
    { type: 'pills', icon: ICON.layers, label: 'Stack',    value: custom.stack    },
    { type: 'pills', icon: ICON.book,   label: 'Learning', value: custom.learning },
  ].map(buildCardModel).filter(Boolean);

  const rightCards = [
    { type: 'pills', icon: ICON.other,    label: 'Other',    value: custom.other    },
    { type: 'text',  icon: ICON.mail,     label: 'Contact',  value: custom.contact  },
    {
      type:  'text',
      icon:  ICON.location,
      label: 'Location',
      value: custom.location,
      link:  custom.location
        ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(custom.location)}`
        : '',
    },
  ].map(buildCardModel).filter(Boolean);

  const colHeight = (cards) =>
    cards.reduce((sum, c) => sum + c.height, 0) + Math.max(0, cards.length - 1) * GAP;

  const leftH  = colHeight(leftCards);
  const rightH = colHeight(rightCards);
  const gridH  = Math.max(leftH, rightH);

  // Balance column heights so the bottom edge of the 2-column Bento grid is flush
  function balanceColumn(cards, currentH, targetH) {
    const diff = targetH - currentH;
    if (diff <= 0 || !cards.length) return;
    const extraEach = Math.floor(diff / cards.length);
    const remainder = diff - extraEach * cards.length;
    cards.forEach((c, idx) => {
      c.height += extraEach + (idx === cards.length - 1 ? remainder : 0);
    });
  }
  balanceColumn(leftCards, leftH, gridH);
  balanceColumn(rightCards, rightH, gridH);

  function renderColumn(cards, colX) {
    let curY = BENTO_Y;
    return cards.map((card) => {
      const y = curY;
      curY += card.height + GAP;

      const contentX = colX + CARD_PAD_X;
      const contentY = y + CARD_PAD_TOP + HEADER_H + CONTENT_GAP;

      let bodyHtml = '';
      if (card.type === 'pills') {
        bodyHtml = card.layout.placed.map((p) => {
          const px = contentX + p.x;
          const py = contentY + p.y;
          const tx = px + p.w / 2;
          return `
  <rect x="${px}" y="${py}" width="${p.w}" height="${p.h}" rx="12" ry="12"
        fill="${T.pillBg}" stroke="${T.pillBorder}" stroke-width="1"/>
  ${textToPath(F.body, p.label, { x: tx, y: py + 16.2, fontSize: p.fontSize, anchor: 'middle', fill: T.valueText })}`;
        }).join('');
      } else {
        let linesHtml = card.lines.map((line, li) =>
          textToPath(F.body, line, { x: contentX, y: contentY + 13 + li * TEXT_LINE_H, fontSize: TEXT_SIZE, fill: T.valueText }),
        ).join('\n  ');
        if (card.link) {
          linesHtml = `<a href="${card.link}" target="_blank">${linesHtml}</a>`;
        }
        bodyHtml = `\n  ${linesHtml}`;
      }

      return `
  <rect x="${colX}" y="${y}" width="${BENTO_COL_W}" height="${card.height}" rx="10" ry="10"
        fill="${T.chipBg}" stroke="${T.chipBorder}" stroke-width="1"/>
  <g transform="translate(${contentX},${y + CARD_PAD_TOP}) scale(0.9)" fill="${T.accent}" color="${T.accent}">${card.icon}</g>
  ${textToPath(F.label, card.label.toUpperCase(), { x: contentX + 22, y: y + CARD_PAD_TOP + 12, fontSize: 11, letterSpacing: 0.9, fill: T.labelText })}${bodyHtml}`;
    }).join('');
  }

  const leftHtml  = renderColumn(leftCards, PAD);
  const rightHtml = renderColumn(rightCards, PAD + BENTO_COL_W + GAP);

  const H         = BENTO_Y + gridH + (gridH > 0 ? 28 : 16);
  const updatedAt = new Date().toISOString().slice(0, 10);

  const accStops = T.accentStops
    .map((c, i) => `<stop offset="${['0%','50%','100%'][i]}" stop-color="${c}"/>`)
    .join('');
  const bdrStops = T.borderStops
    .map((s, i) => `<stop offset="${['0%','50%','100%'][i]}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"/></clipPath>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">${accStops}</linearGradient>
    <linearGradient id="bdr" x1="0" y1="0" x2="1" y2="1">${bdrStops}</linearGradient>
    <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="10" cy="10" r="1" fill="${T.dotColor}" opacity="${T.dotOpacity}"/>
    </pattern>
    <clipPath id="bar">
      <rect x="${BAR_X}" y="${SEGBAR_Y}" width="${BAR_W}" height="${SEGBAR_H}" rx="5" ry="5"/>
    </clipPath>
  </defs>

  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="${T.card}"/>
  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#dots)" clip-path="url(#card)"/>

  <rect y="0" width="${W}" height="3" fill="url(#acc)" clip-path="url(#card)"/>

  <g clip-path="url(#card)">

    ${chipsHtml}

    ${textToPath(F.label, 'LANGUAGES', { x: PAD, y: LANG_TOP, fontSize: 11, letterSpacing: 1.2, fill: T.labelText })}
    <g clip-path="url(#bar)">${segments}</g>
    ${legend}

    ${leftHtml}
    ${rightHtml}

    ${textToPath(F.body, `updated ${updatedAt}`, { x: W - PAD, y: H - 10, fontSize: 10, anchor: 'end', fill: T.timestamp })}

  </g>

  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"
        fill="none" stroke="url(#bdr)" stroke-width="1.5"/>
</svg>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN)    { console.error('GITHUB_TOKEN is required');    process.exit(1); }
  if (!USERNAME) { console.error('GITHUB_USERNAME is required'); process.exit(1); }

  console.log(`[widget] fetching data for ${USERNAME} (theme: ${activeTheme === THEMES.default ? 'default' : (process.env.WIDGET_THEME ?? 'default')})`);

  const [font, { createdAt, publicRepos, repos }] = await Promise.all([
    loadAlloFont(),
    fetchAllRepos(),
  ]);

  const ownedRepos = repos.filter((r) => !r.isFork);
  const forkRepos  = repos.filter((r) =>  r.isFork);
  console.log(`[widget] ${repos.length} total repos (${ownedRepos.length} owned, ${forkRepos.length} forks, ${publicRepos} public)`);

  // Language breakdown: owned repos only, so forked codebases
  // don't skew the language graph toward languages you didn't really choose.
  const langMap = new Map();
  for (const repo of ownedRepos) {
    for (const { size, node } of repo.languages.edges) {
      langMap.set(node.name, (langMap.get(node.name) ?? 0) + size);
    }
  }
  const languages = [...langMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, size]) => ({ name, size }));

  console.log('[widget] fetching lifetime contributions…');
  const lifetimeContribs = await fetchLifetimeContribs(createdAt);

  const yearsOnGithub = formatYears(createdAt);

  // LOC: all repos including forks, but contributor stats filter to your
  // commits only, so you only count lines you actually wrote.
  console.log(`[widget] fetching lines of code across all ${repos.length} repos (including forks)…`);
  const linesOfCode = await fetchLinesOfCode(repos);

  console.log(`[widget] publicRepos=${publicRepos}  lifetime=${lifetimeContribs}  years=${yearsOnGithub}  loc=${linesOfCode}`);

  const svg = buildSVG({
    publicRepos,
    lifetimeContribs,
    yearsOnGithub,
    linesOfCode,
    languages,
    font,
  });

  fs.writeFileSync(OUTPUT_FILE, svg, 'utf8');
  console.log(`[widget] written → ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { buildSVG, loadAlloFont, parsePills, formatYears, THEMES };
