'use strict';

const https = require('https');
const fs    = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME;
if (!TOKEN)    { console.error('GITHUB_TOKEN is required');    process.exit(1); }
if (!USERNAME) { console.error('GITHUB_USERNAME is required'); process.exit(1); }

const CUSTOM = {
  ide:      process.env.WIDGET_IDE      ?? 'VS Code',
  stack:    process.env.WIDGET_STACK    ?? 'JavaScript · Node.js · React',
  learning: process.env.WIDGET_LEARNING ?? 'Rust · Systems Programming',
};

const MAX_LANGS     = 5;
const MAX_LOC_REPOS = 25;
const OUTPUT_FILE   = process.env.OUTPUT_FILE ?? 'github-stats.svg';

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
  if (res.status === 202 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    return fetchContributorStats(nameWithOwner, attempt + 1);
  }
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// ── Data: all non-fork repos (paginated) ──────────────────────────────────────
async function fetchAllRepos(after = null, acc = []) {
  const data = await gqlRequest(`
    query($login: String!, $after: String) {
      user(login: $login) {
        createdAt
        repositories(
          first: 100
          ownerAffiliations: OWNER
          isFork: false
          after: $after
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            nameWithOwner
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `, { login: USERNAME, after });

  const { createdAt, repositories } = data.user;
  acc.push(...repositories.nodes);

  if (repositories.pageInfo.hasNextPage) {
    return fetchAllRepos(repositories.pageInfo.endCursor, acc);
  }
  return { createdAt, repos: acc };
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

async function fetchRecentContribs() {
  const to   = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  return fetchContributions(from.toISOString(), to.toISOString());
}

// ── Data: lines of code (additions + deletions across top repos) ──────────────
async function fetchLinesOfCode(repos) {
  const top     = [...repos]
    .sort((a, b) => b.stargazerCount - a.stargazerCount)
    .slice(0, MAX_LOC_REPOS);
  let total = 0;
  const results = await Promise.allSettled(
    top.map(async (repo) => {
      const stats = await fetchContributorStats(repo.nameWithOwner);
      if (!Array.isArray(stats)) return 0;
      const mine = stats.find(
        (s) => s.author?.login?.toLowerCase() === USERNAME.toLowerCase(),
      );
      return mine ? mine.weeks.reduce((s, w) => s + w.a + w.d, 0) : 0;
    }),
  );
  for (const r of results) {
    if (r.status === 'fulfilled') total += r.value;
  }
  return total;
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Icons (16 × 16 octicon paths) ─────────────────────────────────────────────
// All paths use fill="currentColor" or inherit from a parent fill attribute.
const ICON = {
  star:     `<path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>`,
  commit:   `<path d="M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5H4.07a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5zm-1.43-.75a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z"/>`,
  clock:    `<path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm.75 3.25a.75.75 0 00-1.5 0v3.63L5.22 10.4a.75.75 0 001.06 1.06l2.22-2.22a.75.75 0 00.22-.53V4.75z"/>`,
  code:     `<path d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z"/>`,
  terminal: `<rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5.5l3.5 3-3.5 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><line x1="9.5" y1="11.5" x2="13" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  layers:   `<rect x="1.5" y="1.5"  width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.4"/><rect x="1.5" y="6.25" width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.7"/><rect x="1.5" y="11"   width="13" height="3.5" rx="1.75" fill="currentColor"/>`,
  book:     `<path d="M1 2.5A2.5 2.5 0 013.5 0h9.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 000 2h.75a.75.75 0 010 1.5H3.5A2.5 2.5 0 011 11.5zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1z"/>`,
};

// ── SVG builder ────────────────────────────────────────────────────────────────
function buildSVG({ login, totalStars, lifetimeContribs, recentContribs, linesOfCode, languages }) {
  const W      = 495;
  const PAD    = 22;
  const RADIUS = 14;

  const langs   = languages.slice(0, MAX_LANGS);
  const totalSz = langs.reduce((s, l) => s + l.size, 0) || 1;

  // ── Stat chips (4-column row) ─────────────────────────────────────────────────
  const CHIP_GAP   = 10;
  const CHIP_W     = Math.floor((W - PAD * 2 - CHIP_GAP * 3) / 4); // ~105
  const CHIP_H     = 80;
  const CHIPS_Y    = 82;                              // top of chips row
  const chipStartX = Math.round((W - (CHIP_W * 4 + CHIP_GAP * 3)) / 2);
  const chipXs     = [0, 1, 2, 3].map(i => chipStartX + i * (CHIP_W + CHIP_GAP));

  // ── Language section ──────────────────────────────────────────────────────────
  const LANG_TOP    = CHIPS_Y + CHIP_H + 22;          // "LANGUAGES" label baseline
  const SEGBAR_Y    = LANG_TOP + 9;                   // segmented bar top
  const SEGBAR_H    = 12;
  const LEGEND_Y    = SEGBAR_Y + SEGBAR_H + 14;       // legend rows start
  const LEGEND_ROW  = 22;
  const LEGEND_ROWS = Math.ceil(langs.length / 2);

  // ── About / divider ───────────────────────────────────────────────────────────
  const DIV_Y    = LEGEND_Y + LEGEND_ROWS * LEGEND_ROW + 10;
  const ABOUT_Y  = DIV_Y + 18;
  const ABOUT_ROW = 23;

  const H = ABOUT_Y + 3 * ABOUT_ROW + 16;

  // ── Stat chip data ────────────────────────────────────────────────────────────
  const statsData = [
    { label: 'TOTAL STARS',      value: fmt(totalStars),       color: '#fbbf24', icon: ICON.star   },
    { label: 'LIFETIME COMMITS', value: fmt(lifetimeContribs), color: '#34d399', icon: ICON.commit },
    { label: '14-DAY COMMITS',   value: fmt(recentContribs),   color: '#60a5fa', icon: ICON.clock  },
    { label: 'LINES OF CODE',    value: fmt(linesOfCode),      color: '#c084fc', icon: ICON.code   },
  ];

  const chipsHtml = statsData.map((s, i) => {
    const x  = chipXs[i];
    const cx = x + Math.round(CHIP_W / 2);
    return `
  <rect x="${x}" y="${CHIPS_Y}" width="${CHIP_W}" height="${CHIP_H}" rx="10" ry="10"
        fill="#111827" stroke="#1f2937" stroke-width="1"/>
  <rect x="${x}" y="${CHIPS_Y + 18}" width="3" height="${CHIP_H - 36}" rx="1.5" fill="${s.color}" opacity="0.85"/>
  <g transform="translate(${cx - 8},${CHIPS_Y + 10})" fill="${s.color}">${s.icon}</g>
  <text x="${cx}" y="${CHIPS_Y + 46}" text-anchor="middle"
        font-size="9.5" letter-spacing="0.6" fill="#4b5563">${esc(s.label)}</text>
  <text x="${cx}" y="${CHIPS_Y + 68}" text-anchor="middle"
        font-size="20" font-weight="700" fill="${s.color}">${esc(s.value)}</text>`;
  }).join('');

  // ── Language segmented bar (clipped to rounded rect) ─────────────────────────
  const BAR_X = PAD;
  const BAR_W = W - PAD * 2;
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

  // ── Language legend (2-column) ────────────────────────────────────────────────
  const colW   = Math.floor((W - PAD * 2 - 12) / 2);
  const legend = langs.map((l, i) => {
    const col  = i % 2;
    const row  = Math.floor(i / 2);
    const colX = PAD + col * (colW + 12);
    const y    = LEGEND_Y + row * LEGEND_ROW;
    const pct  = (l.size / totalSz * 100).toFixed(1) + '%';
    const name = l.name.length > 15 ? `${l.name.slice(0, 14)}…` : l.name;
    return `
  <circle cx="${colX + 5}" cy="${y + 5}" r="4.5" fill="${langColor(l.name)}"/>
  <text x="${colX + 14}" y="${y + 10}" font-size="12" fill="#cbd5e1">${esc(name)}</text>
  <text x="${colX + colW}" y="${y + 10}" font-size="12" fill="#4b5563" text-anchor="end">${esc(pct)}</text>`;
  }).join('');

  // ── About rows ────────────────────────────────────────────────────────────────
  const aboutItems = [
    { icon: ICON.terminal, color: '#818cf8', label: 'IDE',      value: CUSTOM.ide      },
    { icon: ICON.layers,   color: '#34d399', label: 'Stack',    value: CUSTOM.stack    },
    { icon: ICON.book,     color: '#f472b6', label: 'Learning', value: CUSTOM.learning },
  ];

  const aboutHtml = aboutItems.map((item, i) => {
    const y = ABOUT_Y + i * ABOUT_ROW;
    return `
  <g transform="translate(${PAD},${y})" fill="${item.color}" color="${item.color}">${item.icon}</g>
  <text x="${PAD + 22}" y="${y + 11}" font-size="12">
    <tspan font-weight="700" fill="${item.color}">${esc(item.label)}</tspan
    ><tspan fill="#475569" dx="7">${esc(item.value)}</tspan>
  </text>`;
  }).join('');

  const updatedAt = new Date().toISOString().slice(0, 10);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <!-- Rounded clip for entire card -->
    <clipPath id="card">
      <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"/>
    </clipPath>
    <!-- Header gradient: deep indigo → card bg -->
    <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#1a1040"/>
      <stop offset="100%" stop-color="#0d1117"/>
    </linearGradient>
    <!-- Header radial glow (purple spotlight at top-center) -->
    <radialGradient id="hglow" cx="50%" cy="0%" r="75%" gradientUnits="objectBoundingBox">
      <stop offset="0%"   stop-color="#5b21b6" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#5b21b6" stop-opacity="0"/>
    </radialGradient>
    <!-- Accent strip: violet → blue → sky -->
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#7c3aed"/>
      <stop offset="50%"  stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#0ea5e9"/>
    </linearGradient>
    <!-- Card border gradient -->
    <linearGradient id="bdr" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#7c3aed" stop-opacity="0.7"/>
      <stop offset="50%"  stop-color="#2563eb" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0.7"/>
    </linearGradient>
    <!-- Dot grid pattern for header -->
    <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="10" cy="10" r="1" fill="white" opacity="0.07"/>
    </pattern>
    <!-- Clip for the language bar rounded ends -->
    <clipPath id="bar">
      <rect x="${BAR_X}" y="${SEGBAR_Y}" width="${BAR_W}" height="${SEGBAR_H}" rx="6" ry="6"/>
    </clipPath>
  </defs>

  <!-- Card base -->
  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="#0d1117"/>

  <g clip-path="url(#card)" font-family="'Segoe UI',system-ui,sans-serif">

    <!-- ── Header ───────────────────────────────────────────────────────── -->
    <rect width="${W}" height="74" fill="url(#hdr)"/>
    <rect width="${W}" height="74" fill="url(#hglow)"/>
    <rect width="${W}" height="74" fill="url(#dots)"/>
    <!-- Accent strip -->
    <rect y="72" width="${W}" height="2" fill="url(#acc)"/>
    <!-- Username -->
    <text x="${W / 2}" y="34" text-anchor="middle"
          font-size="20" font-weight="700" fill="#f1f5f9">${esc(login)}</text>
    <!-- Subtitle -->
    <text x="${W / 2}" y="56" text-anchor="middle"
          font-size="10" letter-spacing="3" fill="#475569">GITHUB STATS</text>

    <!-- ── Stat chips ────────────────────────────────────────────────────── -->
    ${chipsHtml}

    <!-- ── Language section ──────────────────────────────────────────────── -->
    <text x="${PAD}" y="${LANG_TOP}"
          font-size="9.5" letter-spacing="1.5" fill="#374151">LANGUAGES</text>
    <!-- Segmented bar -->
    <g clip-path="url(#bar)">${segments}</g>
    <!-- Legend -->
    ${legend}

    <!-- ── Divider ───────────────────────────────────────────────────────── -->
    <line x1="${PAD}" y1="${DIV_Y}" x2="${W - PAD}" y2="${DIV_Y}"
          stroke="#1e293b" stroke-width="1"/>

    <!-- ── About ─────────────────────────────────────────────────────────── -->
    ${aboutHtml}

    <!-- Updated timestamp -->
    <text x="${W - PAD}" y="${H - 6}" font-size="9" fill="#1f2937" text-anchor="end">
      updated ${updatedAt}
    </text>

  </g>

  <!-- Card border drawn over content -->
  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"
        fill="none" stroke="url(#bdr)" stroke-width="1.5"/>
</svg>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[widget] fetching data for ${USERNAME}`);

  const { createdAt, repos } = await fetchAllRepos();
  console.log(`[widget] ${repos.length} repos found`);

  // Aggregate stars and language byte counts from repo metadata
  let totalStars = 0;
  const langMap  = new Map();
  for (const repo of repos) {
    totalStars += repo.stargazerCount;
    for (const { size, node } of repo.languages.edges) {
      langMap.set(node.name, (langMap.get(node.name) ?? 0) + size);
    }
  }
  const languages = [...langMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, size]) => ({ name, size }));

  console.log('[widget] fetching lifetime contributions…');
  const lifetimeContribs = await fetchLifetimeContribs(createdAt);

  console.log('[widget] fetching 14-day contributions…');
  const recentContribs = await fetchRecentContribs();

  console.log(`[widget] fetching lines of code (up to ${MAX_LOC_REPOS} repos)…`);
  const linesOfCode = await fetchLinesOfCode(repos);

  console.log(`[widget] stars=${totalStars}  lifetime=${lifetimeContribs}  14d=${recentContribs}  loc=${linesOfCode}`);

  const svg = buildSVG({
    login: USERNAME,
    totalStars,
    lifetimeContribs,
    recentContribs,
    linesOfCode,
    languages,
  });

  fs.writeFileSync(OUTPUT_FILE, svg, 'utf8');
  console.log(`[widget] written → ${OUTPUT_FILE}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
