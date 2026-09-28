#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) throw new Error('usage: ua-tour-analyze.js <input.json> <output.json>');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const layers = data.layers || [];

  const byId = new Map(nodes.map(n => [n.id, n]));
  const nameOf = id => (byId.get(id) || {}).name || id;
  const sumOf = id => (byId.get(id) || {}).summary || '';

  // A/B fan-in and fan-out
  const fanIn = new Map(), fanOut = new Map();
  for (const n of nodes) { fanIn.set(n.id, 0); fanOut.set(n.id, 0); }
  for (const e of edges) {
    if (fanOut.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
    if (fanIn.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
  }
  const rank = (m, key) => [...m.entries()]
    .map(([id, v]) => ({ id, [key]: v, name: nameOf(id) }))
    .sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id))
    .slice(0, 20);
  const fanInRanking = rank(fanIn, 'fanIn');
  const fanOutRanking = rank(fanOut, 'fanOut');

  // C entry point candidates
  const ENTRY_NAMES = new Set(['index.ts','index.js','main.ts','main.js','app.ts','app.js','server.ts','server.js','mod.rs','main.go','main.py','main.rs','manage.py','app.py','wsgi.py','asgi.py','run.py','__main__.py','Application.java','Main.java','Program.cs','config.ru','index.php','App.swift','Application.kt','main.cpp','main.c']);
  const outVals = [...fanOut.values()].sort((a, b) => b - a);
  const inVals = [...fanIn.values()].sort((a, b) => a - b);
  const top10Out = outVals.length ? outVals[Math.max(0, Math.floor(outVals.length * 0.1) - 1)] : 0;
  const bot25In = inVals.length ? inVals[Math.max(0, Math.ceil(inVals.length * 0.25) - 1)] : 0;

  const candidates = [];
  for (const n of nodes) {
    const fp = n.filePath || '';
    const base = path.basename(fp || n.name || '');
    const depth = fp ? fp.split('/').length : 1;
    let score = 0;
    if (n.type === 'document' || /\.md$/i.test(base)) {
      if (base.toLowerCase() === 'readme.md' && depth === 1) score += 5;
      else if (/\.md$/i.test(base) && depth === 1) score += 2;
    } else {
      if (ENTRY_NAMES.has(base)) score += 3;
      if (depth <= 2) score += 1;
      if ((fanOut.get(n.id) || 0) >= top10Out && top10Out > 0) score += 1;
      if ((fanIn.get(n.id) || 0) <= bot25In) score += 1;
    }
    if (score > 0) candidates.push({ id: n.id, score, name: n.name, type: n.type, summary: sumOf(n.id) });
  }
  candidates.sort((a, b) => b.score - a.score || (fanOut.get(b.id) || 0) - (fanOut.get(a.id) || 0));
  const entryPointCandidates = candidates.slice(0, 5);

  // D BFS from top *code* entry point
  const isCode = id => {
    const n = byId.get(id) || {};
    return n.type !== 'document' && !/^document:/.test(id);
  };
  const traversalEdgeTypes = new Set(['imports', 'calls']);
  const adj = new Map();
  for (const e of edges) {
    if (!traversalEdgeTypes.has(e.type)) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    adj.get(e.source).add(e.target);
  }
  let start = null;
  for (const c of candidates) { if (isCode(c.id) && (adj.get(c.id) || new Set()).size > 0) { start = c.id; break; } }
  if (!start) {
    // fall back: highest fan-out code node
    const best = fanOutRanking.find(r => isCode(r.id));
    start = best ? best.id : (nodes[0] || {}).id;
  }
  const order = [], depthMap = {};
  if (start) {
    const q = [start];
    depthMap[start] = 0;
    const seen = new Set([start]);
    while (q.length) {
      const cur = q.shift();
      order.push(cur);
      for (const nx of adj.get(cur) || []) {
        if (seen.has(nx)) continue;
        seen.add(nx);
        depthMap[nx] = depthMap[cur] + 1;
        q.push(nx);
      }
    }
  }
  const byDepth = {};
  for (const [id, d] of Object.entries(depthMap)) {
    (byDepth[d] = byDepth[d] || []).push(id);
  }

  // E non-code inventory
  const buckets = { documentation: [], infrastructure: [], data: [], config: [] };
  const catOf = t => t === 'document' ? 'documentation'
    : (['service', 'pipeline', 'resource'].includes(t) ? 'infrastructure'
    : (['table', 'schema', 'endpoint'].includes(t) ? 'data'
    : (t === 'config' ? 'config' : null)));
  for (const n of nodes) {
    const c = catOf(n.type);
    if (c) buckets[c].push({ id: n.id, name: n.name, type: n.type, summary: n.summary || '' });
  }

  // F clusters
  const pairCount = new Map();
  const undirected = new Map();
  const addU = (a, b) => { if (!undirected.has(a)) undirected.set(a, new Set()); undirected.get(a).add(b); };
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    const k = [e.source, e.target].sort().join('||');
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
    addU(e.source, e.target); addU(e.target, e.source);
  }
  const hasDir = new Set(edges.filter(e => traversalEdgeTypes.has(e.type)).map(e => e.source + '>>' + e.target));
  const degree = id => (undirected.get(id) || new Set()).size;
  const seedKeys = [];
  for (const k of pairCount.keys()) {
    const [a, b] = k.split('||');
    const bidir = (hasDir.has(a + '>>' + b) && hasDir.has(b + '>>' + a));
    seedKeys.push({ k, w: pairCount.get(k) * 10 + (bidir ? 100 : 0) + degree(a) + degree(b) });
  }
  seedKeys.sort((a, b) => b.w - a.w);
  const seedOrder = seedKeys.map(s => s.k);
  const clusters = [];
  const claimed = new Set();
  for (const k of seedOrder) {
    const [a, b] = k.split('||');
    if (claimed.has(a) || claimed.has(b)) continue;
    const members = new Set([a, b]);
    let grew = true;
    while (grew && members.size < 5) {
      grew = false;
      const counts = new Map();
      for (const m of members) for (const nb of undirected.get(m) || []) {
        if (members.has(nb) || claimed.has(nb)) continue;
        counts.set(nb, (counts.get(nb) || 0) + 1);
      }
      let bestN = null, bestC = 0;
      for (const [nb, c] of counts) if (c > bestC || (c === bestC && bestN && degree(nb) > degree(bestN))) { bestN = nb; bestC = c; }
      if (bestN && bestC >= 1) { members.add(bestN); grew = true; }
    }
    let edgeCount = 0;
    for (const e of edges) if (members.has(e.source) && members.has(e.target)) edgeCount++;
    if (members.size >= 2 && edgeCount >= 2) {
      clusters.push({ nodes: [...members], edgeCount, names: [...members].map(nameOf) });
      for (const m of members) claimed.add(m);
    }
    if (clusters.length >= 10) break;
  }
  clusters.sort((a, b) => b.edgeCount - a.edgeCount);

  // H node summary index
  const nodeSummaryIndex = {};
  for (const n of nodes) nodeSummaryIndex[n.id] = { name: n.name, type: n.type, filePath: n.filePath, summary: n.summary || '' };

  const results = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal: { startNode: start, order, depthMap, byDepth },
    nonCodeFiles: buckets,
    clusters,
    layers: { count: layers.length, list: layers },
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('wrote', outPath, 'nodes', nodes.length, 'edges', edges.length, 'start', start);
}

try { main(); } catch (err) { console.error(err && err.stack || String(err)); process.exit(1); }
