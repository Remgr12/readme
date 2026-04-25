'use strict';

const https = require('https');
const fs    = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME;
if (!TOKEN)    { console.error('GITHUB_TOKEN is required');    process.exit(1); }
if (!USERNAME) { console.error('GITHUB_USERNAME is required'); process.exit(1); }

const CUSTOM = {
  ide:      process.env.WIDGET_IDE      || '',
  stack:    process.env.WIDGET_STACK    || '',
  learning: process.env.WIDGET_LEARNING || '',
  contact:  process.env.WIDGET_CONTACT  || '',
  location: process.env.WIDGET_LOCATION || '',
};

const MAX_LANGS     = 5;
const MAX_LOC_REPOS = 25;
const OUTPUT_FILE   = process.env.OUTPUT_FILE ?? 'github-stats.svg';

// ── Fonts ──────────────────────────────────────────────────────────────────────
// JetBrains Mono  → stat values, body text, timestamps
// Space Mono      → uppercase labels (TOTAL STARS, LANGUAGES, IDE, etc.)
const FONT_LABEL = `'Space Mono', 'Courier New', monospace`;
const FONT_BODY  = `'JetBrains Mono', 'Courier New', monospace`;
const FONT_EMBED = `<style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&amp;family=Space+Mono:wght@400;700&amp;display=swap');</style>`;

// ── Themes ─────────────────────────────────────────────────────────────────────
// Select via WIDGET_THEME env var: 'default' | 'nord' | 'catppuccin'
const THEMES = {
  default: {
    card:        '#0d1117',
    chipBg:      '#111827',
    chipBorder:  '#1f2937',
    divider:     '#1e293b',
    langLabel:   '#374151',
    legendText:  '#cbd5e1',
    legendPct:   '#4b5563',
    chipLabel:   '#4b5563',
    valueText:   '#94a3b8',
    timestamp:   '#1f2937',
    dotColor:    '#ffffff',
    dotOpacity:  0.07,
    accentStops: ['#7c3aed', '#2563eb', '#0ea5e9'],
    borderStops: [
      { color: '#7c3aed', opacity: 0.70 },
      { color: '#2563eb', opacity: 0.25 },
      { color: '#0ea5e9', opacity: 0.70 },
    ],
    statColors:  ['#fbbf24', '#34d399', '#60a5fa', '#c084fc'],
    aboutColors: ['#818cf8', '#34d399', '#f472b6', '#fbbf24', '#60a5fa'],
  },

  nord: {
    card:        '#2e3440',
    chipBg:      '#3b4252',
    chipBorder:  '#4c566a',
    divider:     '#434c5e',
    langLabel:   '#d8dee9',
    legendText:  '#eceff4',
    legendPct:   '#d8dee9',
    chipLabel:   '#d8dee9',
    valueText:   '#eceff4',
    timestamp:   '#81a1c1',
    dotColor:    '#eceff4',
    dotOpacity:  0.05,
    accentStops: ['#8fbcbb', '#81a1c1', '#5e81ac'],
    borderStops: [
      { color: '#88c0d0', opacity: 0.70 },
      { color: '#5e81ac', opacity: 0.25 },
      { color: '#81a1c1', opacity: 0.70 },
    ],
    statColors:  ['#ebcb8b', '#a3be8c', '#88c0d0', '#b48ead'],
    aboutColors: ['#81a1c1', '#a3be8c', '#d08770', '#ebcb8b', '#b48ead'],
  },

  catppuccin: {
    card:        '#1e1e2e',
    chipBg:      '#313244',
    chipBorder:  '#45475a',
    divider:     '#313244',
    langLabel:   '#585b70',
    legendText:  '#cdd6f4',
    legendPct:   '#6c7086',
    chipLabel:   '#6c7086',
    valueText:   '#a6adc8',
    timestamp:   '#45475a',
    dotColor:    '#cdd6f4',
    dotOpacity:  0.04,
    accentStops: ['#cba6f7', '#89b4fa', '#89dceb'],
    borderStops: [
      { color: '#cba6f7', opacity: 0.70 },
      { color: '#89b4fa', opacity: 0.25 },
      { color: '#89dceb', opacity: 0.70 },
    ],
    statColors:  ['#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7'],
    aboutColors: ['#cba6f7', '#a6e3a1', '#f38ba8', '#f9e2af', '#89dceb'],
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

// ── About text wrapping ────────────────────────────────────────────────────────
// JetBrains Mono is slightly wider than Arial — use 7.2px per char at 12px
function wrapAbout(text, availWidth) {
  if (text.includes('\n')) return text.split('\n');

  const MAX_CHARS = Math.floor(availWidth / 7.2);
  if (text.length <= MAX_CHARS) return [text];

  function pack(tokens, sep) {
    const lines = [];
    let line = '';
    for (const tok of tokens) {
      const candidate = line ? `${line}${sep}${tok}` : tok;
      if (candidate.length <= MAX_CHARS) { line = candidate; }
      else { if (line) lines.push(line); line = tok; }
    }
    if (line) lines.push(line);
    return lines;
  }

  const dotTokens = text.split(/\s+·\s+/);
  if (dotTokens.length > 1) return pack(dotTokens, ' · ');
  return pack(text.split(' '), ' ');
}

// ── Icons (16 × 16 octicon paths) ─────────────────────────────────────────────
const ICON = {
  star:     `<path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>`,
  commit:   `<path d="M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5H4.07a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5zm-1.43-.75a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z"/>`,
  clock:    `<path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm.75 3.25a.75.75 0 00-1.5 0v3.63L5.22 10.4a.75.75 0 001.06 1.06l2.22-2.22a.75.75 0 00.22-.53V4.75z"/>`,
  code:     `<path d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z"/>`,
  terminal: `<rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 5.5l3.5 3-3.5 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><line x1="9.5" y1="11.5" x2="13" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  layers:   `<rect x="1.5" y="1.5"  width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.4"/><rect x="1.5" y="6.25" width="13" height="3.5" rx="1.75" fill="currentColor" opacity="0.7"/><rect x="1.5" y="11"   width="13" height="3.5" rx="1.75" fill="currentColor"/>`,
  book:     `<path d="M1 2.5A2.5 2.5 0 013.5 0h9.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 000 2h.75a.75.75 0 010 1.5H3.5A2.5 2.5 0 011 11.5zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1z"/>`,
  mail:     `<path d="M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2Zm12.5 1.5H1.75a.25.25 0 0 0-.25.25v.32l6.5 4.5 6.5-4.5v-.32a.25.25 0 0 0-.25-.25ZM1.5 5.809v6.442c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V5.809l-6.5 4.5Z"/>`,
  location: `<path d="M8 0a6.5 6.5 0 0 1 6.5 6.5c0 4.673-4.996 9.68-6.136 10.74a.5.5 0 0 1-.728 0C6.496 16.18 1.5 11.173 1.5 6.5A6.5 6.5 0 0 1 8 0Zm0 1.5a5 5 0 0 0-5 5c0 3.398 3.55 7.42 5 8.89 1.45-1.47 5-5.492 5-8.89a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/>`,
};

// ── SVG builder ────────────────────────────────────────────────────────────────
function buildSVG({ totalStars, lifetimeContribs, recentContribs, linesOfCode, languages }) {
  const T      = activeTheme;
  const W      = 856;
  const PAD    = 24;
  const RADIUS = 14;

  const langs   = languages.slice(0, MAX_LANGS);
  const totalSz = langs.reduce((s, l) => s + l.size, 0) || 1;

  // ── Stat chips — 4 across ─────────────────────────────────────────────────────
  const CHIP_GAP   = 12;
  const CHIP_W     = Math.floor((W - PAD * 2 - CHIP_GAP * 3) / 4);
  const CHIP_H     = 80;
  const CHIPS_Y    = 16;
  const chipStartX = Math.round((W - (CHIP_W * 4 + CHIP_GAP * 3)) / 2);
  const chipXs     = [0, 1, 2, 3].map((i) => chipStartX + i * (CHIP_W + CHIP_GAP));

  // ── Language section ──────────────────────────────────────────────────────────
  const LANG_TOP    = CHIPS_Y + CHIP_H + 20;
  const SEGBAR_Y    = LANG_TOP + 10;
  const SEGBAR_H    = 12;
  const LEGEND_Y    = SEGBAR_Y + SEGBAR_H + 14;
  const LEGEND_ROW  = 22;
  const LEGEND_ROWS = Math.ceil(langs.length / 2);

  // ── About section ─────────────────────────────────────────────────────────────
  const ABOUT_INDENT  = PAD + 24;
  const ABOUT_VALUE_W = W - ABOUT_INDENT - PAD;
  const ABOUT_LABEL_H = 16;
  const ABOUT_VALUE_H = 18;
  const ABOUT_GAP     = 14;

  const aboutItems = [
    { icon: ICON.terminal, color: T.aboutColors[0], label: 'IDE',      value: CUSTOM.ide      },
    { icon: ICON.layers,   color: T.aboutColors[1], label: 'Stack',    value: CUSTOM.stack    },
    { icon: ICON.book,     color: T.aboutColors[2], label: 'Learning', value: CUSTOM.learning },
    { separator: true },
    { icon: ICON.mail,     color: T.aboutColors[3], label: 'Contact',  value: CUSTOM.contact  },
    { icon: ICON.location, color: T.aboutColors[4], label: 'Location', value: CUSTOM.location, link: CUSTOM.location ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(CUSTOM.location)}` : '' },
  ].filter(item => item.separator || item.value);

  while (aboutItems.length && aboutItems[0].separator) aboutItems.shift();
  while (aboutItems.length && aboutItems[aboutItems.length - 1].separator) aboutItems.pop();

  const aboutData = aboutItems.map((item) => {
    if (item.separator) return item;
    return { ...item, lines: wrapAbout(item.value, ABOUT_VALUE_W) };
  });

  const totalAboutH = aboutData.reduce((sum, item) => {
    if (item.separator) return sum + 24;
    return sum + ABOUT_LABEL_H + item.lines.length * ABOUT_VALUE_H + ABOUT_GAP;
  }, 0);

  const DIV_Y   = LEGEND_Y + LEGEND_ROWS * LEGEND_ROW + 12;
  const ABOUT_Y = DIV_Y + 18;
  const H       = ABOUT_Y + totalAboutH + 12;

  const BAR_X = PAD;
  const BAR_W = W - PAD * 2;

  // ── Stat chips ────────────────────────────────────────────────────────────────
  const statsData = [
    { label: 'TOTAL STARS',      value: fmt(totalStars),       color: T.statColors[0], icon: ICON.star   },
    { label: 'LIFETIME COMMITS', value: fmt(lifetimeContribs), color: T.statColors[1], icon: ICON.commit },
    { label: '14-DAY COMMITS',   value: fmt(recentContribs),   color: T.statColors[2], icon: ICON.clock  },
    { label: 'LINES OF CODE',    value: fmt(linesOfCode),      color: T.statColors[3], icon: ICON.code   },
  ];

  const chipsHtml = statsData.map((s, i) => {
    const x  = chipXs[i];
    const cx = x + Math.round(CHIP_W / 2);
    return `
  <rect x="${x}" y="${CHIPS_Y}" width="${CHIP_W}" height="${CHIP_H}" rx="10" ry="10"
        fill="${T.chipBg}" stroke="${T.chipBorder}" stroke-width="1"/>
  <rect x="${x}" y="${CHIPS_Y + 18}" width="3" height="${CHIP_H - 36}" rx="1.5"
        fill="${s.color}" opacity="0.85"/>
  <g transform="translate(${cx - 8},${CHIPS_Y + 10})" fill="${s.color}">${s.icon}</g>
  <text x="${cx}" y="${CHIPS_Y + 46}" text-anchor="middle"
        font-family="${FONT_LABEL}" font-weight="bold" font-size="9" letter-spacing="0.6" fill="${T.chipLabel}">${esc(s.label)}</text>
  <text x="${cx}" y="${CHIPS_Y + 68}" text-anchor="middle"
        font-family="${FONT_BODY}" font-size="20" font-weight="bold" fill="${s.color}">${esc(s.value)}</text>`;
  }).join('');

  // ── Language segmented bar ────────────────────────────────────────────────────
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
  const colW   = Math.floor((W - PAD * 2 - 16) / 2);
  const legend = langs.map((l, i) => {
    const col  = i % 2;
    const row  = Math.floor(i / 2);
    const colX = PAD + col * (colW + 16);
    const y    = LEGEND_Y + row * LEGEND_ROW;
    const pct  = (l.size / totalSz * 100).toFixed(1) + '%';
    const name = l.name.length > 18 ? `${l.name.slice(0, 17)}…` : l.name;
    return `
  <circle cx="${colX + 5}" cy="${y + 5}" r="4.5" fill="${langColor(l.name)}"/>
  <text x="${colX + 14}" y="${y + 10}" font-family="${FONT_BODY}" font-size="12" fill="${T.legendText}">${esc(name)}</text>
  <text x="${colX + colW}" y="${y + 10}" font-family="${FONT_BODY}" font-size="12" fill="${T.legendPct}"
        text-anchor="end">${esc(pct)}</text>`;
  }).join('');

  // ── About rows ────────────────────────────────────────────────────────────────
  let curY = ABOUT_Y;
  const aboutHtml = aboutData.map((item) => {
    if (item.separator) {
      const sepY = curY;
      curY += 24;
      return `\n  <line x1="${PAD}" y1="${sepY + 4}" x2="${W - PAD}" y2="${sepY + 4}" stroke="${T.divider}" stroke-width="1"/>`;
    }

    const labelY      = curY + ABOUT_LABEL_H;
    const firstValueY = labelY + ABOUT_VALUE_H - 1;
    let linesHtml = item.lines.map((line, li) =>
      `<text x="${ABOUT_INDENT}" y="${firstValueY + li * ABOUT_VALUE_H}"
             font-family="${FONT_BODY}" font-size="12.5" fill="${T.valueText}">${esc(line)}</text>`).join('');

    if (item.link) {
      linesHtml = `<a href="${item.link}" target="_blank">${linesHtml}</a>`;
    }

    const chunk = `
  <g transform="translate(${PAD},${curY})" fill="${item.color}" color="${item.color}">${item.icon}</g>
  <text x="${ABOUT_INDENT}" y="${labelY}" font-family="${FONT_LABEL}" font-weight="bold" font-size="9" letter-spacing="1" fill="${item.color}">${esc(item.label.toUpperCase())}</text>
  ${linesHtml}`;
    curY += ABOUT_LABEL_H + item.lines.length * ABOUT_VALUE_H + ABOUT_GAP;
    return chunk;
  }).join('');

  const updatedAt = new Date().toISOString().slice(0, 10);

  const accStops = T.accentStops
    .map((c, i) => `<stop offset="${['0%','50%','100%'][i]}" stop-color="${c}"/>`)
    .join('');
  const bdrStops = T.borderStops
    .map((s, i) => `<stop offset="${['0%','50%','100%'][i]}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${FONT_EMBED}
    <clipPath id="card"><rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"/></clipPath>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">${accStops}</linearGradient>
    <linearGradient id="bdr" x1="0" y1="0" x2="1" y2="1">${bdrStops}</linearGradient>
    <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="10" cy="10" r="1" fill="${T.dotColor}" opacity="${T.dotOpacity}"/>
    </pattern>
    <clipPath id="bar">
      <rect x="${BAR_X}" y="${SEGBAR_Y}" width="${BAR_W}" height="${SEGBAR_H}" rx="6" ry="6"/>
    </clipPath>
  </defs>

  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="${T.card}"/>
  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#dots)" clip-path="url(#card)"/>

  <rect y="0" width="${W}" height="3" fill="url(#acc)" clip-path="url(#card)"/>

  <g clip-path="url(#card)" font-family="${FONT_BODY}">

    ${chipsHtml}

    <text x="${PAD}" y="${LANG_TOP}"
          font-family="${FONT_LABEL}" font-weight="bold" font-size="9" letter-spacing="1.5" fill="${T.langLabel}">LANGUAGES</text>
    <g clip-path="url(#bar)">${segments}</g>
    ${legend}

    <line x1="${PAD}" y1="${DIV_Y}" x2="${W - PAD}" y2="${DIV_Y}"
          stroke="${T.divider}" stroke-width="1"/>

    ${aboutHtml}

    <text x="${W - PAD}" y="${H - 6}" font-family="${FONT_LABEL}" font-size="9" fill="${T.timestamp}"
          text-anchor="end">updated ${updatedAt}</text>

  </g>

  <rect width="${W}" height="${H}" rx="${RADIUS}" ry="${RADIUS}"
        fill="none" stroke="url(#bdr)" stroke-width="1.5"/>
</svg>`;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[widget] fetching data for ${USERNAME} (theme: ${activeTheme === THEMES.default ? 'default' : (process.env.WIDGET_THEME ?? 'default')})`);

  const { createdAt, repos } = await fetchAllRepos();
  console.log(`[widget] ${repos.length} repos found`);

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
