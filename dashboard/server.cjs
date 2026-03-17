#!/usr/bin/env node
// AI Dashboard Server – Ollama + OpenClaw + Calendar
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 4242;
const PROJECT_DIR = path.join(__dirname, '..');
const OPENCLAW_STATE_DIR = path.join(PROJECT_DIR, '.openclaw');
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const AGENTS_DIR = path.join(require('os').homedir(), 'Documents', 'AI-Agents');
const ACTIVE_PERSONA = path.join(OPENCLAW_STATE_DIR, 'workspace', 'AGENTS.md');

// ── helpers ──────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
}

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return []; }
}

function writeTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// ── Ollama ────────────────────────────────────────────────────────────────────

function proxyOllama(endpoint, res) {
  const options = { hostname: '127.0.0.1', port: 11434, path: endpoint, method: 'GET' };
  const req = http.request(options, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => { cors(res); res.writeHead(200); res.end(data); });
  });
  req.on('error', (err) => {
    cors(res); res.writeHead(503);
    res.end(JSON.stringify({ error: 'Ollama nicht erreichbar', detail: err.message }));
  });
  req.end();
}

// ── OpenClaw ──────────────────────────────────────────────────────────────────

function getOpenClawStatus(res) {
  const cmd = `cd "${PROJECT_DIR}" && OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" pnpm openclaw channels status 2>&1`;
  exec(cmd, { timeout: 12000 }, (err, stdout) => {
    cors(res); res.writeHead(200);
    res.end(JSON.stringify({ raw: stdout || '', error: err ? err.message : null }));
  });
}

// ── macOS Calendar (icalBuddy) ────────────────────────────────────────────────

function getMacCalendar(from, to, res) {
  // Format: YYYY-MM-DD
  const cmd = `/opt/homebrew/bin/icalBuddy -f -b "•" -nc -iep "title,datetime,notes" eventsFrom:"${from}" to:"${to}" 2>/dev/null`;
  exec(cmd, { timeout: 8000 }, (err, stdout) => {
    cors(res); res.writeHead(200);
    if (err || !stdout.trim()) {
      res.end(JSON.stringify({ events: [] }));
      return;
    }
    // Parse icalBuddy output
    const events = [];
    const blocks = stdout.split('\n•').filter(Boolean);
    blocks.forEach(block => {
      const lines = block.replace(/^•/, '').trim().split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const title = lines[0];
      let date = null, notes = '';
      for (const l of lines.slice(1)) {
        const dm = l.match(/(\d{4}-\d{2}-\d{2})/);
        if (dm) date = dm[1];
        if (l.startsWith('notes:')) notes = l.replace('notes:', '').trim();
      }
      if (title && date) events.push({ id: `mac-${date}-${title}`, title, date, notes, source: 'mac' });
    });
    res.end(JSON.stringify({ events }));
  });
}

// ── GitHub Issues ─────────────────────────────────────────────────────────────

function getGitHubIssues(res) {
  const cmd = `/opt/homebrew/bin/gh issue list --repo openclaw/openclaw --state open --limit 50 --json number,title,createdAt,labels,milestone,assignees 2>&1`;
  exec(cmd, { timeout: 15000 }, (err, stdout) => {
    cors(res); res.writeHead(200);
    if (err || stdout.includes('not logged')) {
      res.end(JSON.stringify({ issues: [], authRequired: true }));
      return;
    }
    try {
      const raw = JSON.parse(stdout);
      const issues = raw.map(i => ({
        id: `gh-${i.number}`,
        number: i.number,
        title: i.title,
        date: i.createdAt ? i.createdAt.substring(0, 10) : null,
        labels: (i.labels || []).map(l => l.name),
        milestone: i.milestone?.title || null,
        url: `https://github.com/openclaw/openclaw/issues/${i.number}`,
        source: 'github'
      }));
      res.end(JSON.stringify({ issues }));
    } catch {
      res.end(JSON.stringify({ issues: [], error: 'Parse-Fehler' }));
    }
  });
}

// ── Manual Tasks ──────────────────────────────────────────────────────────────

function handleTasks(req, res, url) {
  if (req.method === 'GET') {
    cors(res); res.writeHead(200);
    res.end(JSON.stringify(readTasks()));
    return;
  }
  if (req.method === 'POST') {
    body(req).then(data => {
      const tasks = readTasks();
      const task = { id: `task-${Date.now()}`, ...data, source: 'manual', createdAt: new Date().toISOString() };
      tasks.push(task);
      writeTasks(tasks);
      cors(res); res.writeHead(201);
      res.end(JSON.stringify(task));
    });
    return;
  }
  if (req.method === 'DELETE') {
    const id = url.split('/').pop();
    const tasks = readTasks().filter(t => t.id !== id);
    writeTasks(tasks);
    cors(res); res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(405); res.end();
}

// ── Usage & Costs ─────────────────────────────────────────────────────────────

function getUsage(res) {
  const os = require('os');

  // ── OpenClaw: aggregate actual costs from session JSONLs ──
  const ocSessions = [];
  try {
    const glob = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) glob(full);
        else if (e.name.endsWith('.jsonl')) ocSessions.push(full);
      }
    };
    glob(OPENCLAW_STATE_DIR);
  } catch {}

  const ocTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const ocModels = {};
  let ocCostUSD = 0;

  for (const fp of ocSessions) {
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const d = JSON.parse(line);
        const usage = d?.message?.usage;
        if (!usage) continue;
        const cost = usage.cost || {};
        ocCostUSD += (cost.input || 0) + (cost.output || 0) + (cost.cacheRead || 0) + (cost.cacheWrite || 0);
        ocTotals.input      += usage.input      || 0;
        ocTotals.output     += usage.output     || 0;
        ocTotals.cacheRead  += usage.cacheRead  || 0;
        ocTotals.cacheWrite += usage.cacheWrite || 0;
        ocTotals.totalTokens += usage.totalTokens || 0;
        const model = d?.message?.model;
        if (model && !['delivery-mirror','gateway-injected'].includes(model)) {
          ocModels[model] = (ocModels[model] || 0) + 1;
        }
      }
    } catch {}
  }

  // ── Claude Code: aggregate tokens + estimate costs ──
  const PRICING = {
    'claude-sonnet-4-6':         { in: 3.0,  out: 15.0,  cr: 0.30,  cw: 3.75 },
    'claude-haiku-4-5-20251001': { in: 0.80, out: 4.0,   cr: 0.08,  cw: 1.0  },
    'claude-haiku-3-5':          { in: 0.80, out: 4.0,   cr: 0.08,  cw: 1.0  },
    'claude-3-haiku-20240307':   { in: 0.25, out: 1.25,  cr: 0.03,  cw: 0.30 },
    'claude-opus-4-6':           { in: 15.0, out: 75.0,  cr: 1.50,  cw: 18.75 },
  };

  const ccDir = path.join(os.homedir(), '.claude', 'projects');
  const ccTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const ccModels = {};
  let ccCostUSD = 0;

  const walkCC = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'subagents') walkCC(full);
        else if (e.name.endsWith('.jsonl')) {
          const lines = fs.readFileSync(full, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              const u = d?.message?.usage;
              if (!u) continue;
              const model = d?.message?.model || '';
              const p = PRICING[model] || { in: 3.0, out: 15.0, cr: 0.30, cw: 3.75 };
              const inp = u.input_tokens || 0;
              const out = u.output_tokens || 0;
              const cr  = u.cache_read_input_tokens || 0;
              const cw  = u.cache_creation_input_tokens || 0;
              ccTotals.input      += inp;
              ccTotals.output     += out;
              ccTotals.cacheRead  += cr;
              ccTotals.cacheWrite += cw;
              ccCostUSD += (inp * p.in + out * p.out + cr * p.cr + cw * p.cw) / 1e6;
              if (model && model !== '<synthetic>') {
                ccModels[model] = (ccModels[model] || 0) + 1;
              }
            } catch {}
          }
        }
      }
    } catch {}
  };
  walkCC(ccDir);

  cors(res); res.writeHead(200);
  res.end(JSON.stringify({
    openclaw: { costUSD: Math.round((ocCostUSD / 100) * 10000) / 10000, tokens: ocTotals, models: ocModels },
    claudecode: { costUSD: Math.round(ccCostUSD * 100) / 100, tokens: ccTotals, models: ccModels },
  }));
}

// ── Agents ────────────────────────────────────────────────────────────────────

function getAgents(res) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'registry.json'), 'utf8'));
    const defaultAgentId = registry.defaultAgent;

    // Determine which persona is currently active in OpenClaw
    let activePersonaContent = '';
    try { activePersonaContent = fs.readFileSync(ACTIVE_PERSONA, 'utf8'); } catch {}

    const agents = registry.agents.map(a => {
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, a.path, 'config.json'), 'utf8'));
      } catch {}

      // Agent is "active" if its persona is the one currently loaded in OpenClaw
      let personaContent = '';
      try { personaContent = fs.readFileSync(path.join(AGENTS_DIR, a.path, 'persona.md'), 'utf8'); } catch {}
      const isActive = activePersonaContent.length > 0 && personaContent.length > 0
        && activePersonaContent.trim() === personaContent.trim();

      return {
        ...a,
        config,
        isDefault: a.id === defaultAgentId,
        isActive,
      };
    });

    cors(res); res.writeHead(200);
    res.end(JSON.stringify({ agents, defaultAgent: defaultAgentId, repoPath: AGENTS_DIR }));
  } catch (err) {
    cors(res); res.writeHead(500);
    res.end(JSON.stringify({ error: 'Agents-Repo nicht gefunden', detail: err.message }));
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204); res.end(); return;
  }

  if (url === '/' || url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html); return;
  }

  if (url === '/api/usage')               return getUsage(res);
  if (url === '/api/agents')              return getAgents(res);
  if (url === '/api/ollama/ps')           return proxyOllama('/api/ps', res);
  if (url === '/api/ollama/tags')         return proxyOllama('/api/tags', res);
  if (url === '/api/openclaw/status')     return getOpenClawStatus(res);
  if (url === '/api/github/issues')       return getGitHubIssues(res);
  if (url.startsWith('/api/tasks'))       return handleTasks(req, res, url);
  if (url === '/api/calendar/mac') {
    const now = new Date();
    const from = params.from || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const to   = params.to   || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-31`;
    return getMacCalendar(from, to, res);
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
