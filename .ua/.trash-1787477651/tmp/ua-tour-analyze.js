#!/usr/bin/env node
'use strict';

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  fail('Usage: node ua-tour-analyze.js <input.json> <output.json>');
}

const fs = require('fs');
const path = require('path');

let data;
try {
  const raw = fs.readFileSync(inputPath, 'utf8');
  data = JSON.parse(raw);
} catch (e) {
  fail('Failed to read/parse input file: ' + e.message);
}

const nodes = Array.isArray(data.nodes) ? data.nodes : [];
const edges = Array.isArray(data.edges) ? data.edges : [];
const layers = Array.isArray(data.layers) ? data.layers : [];

if (nodes.length === 0) {
  fail('No nodes found in input');
}

const nodeById = new Map();
for (const n of nodes) {
  nodeById.set(n.id, n);
}

// Only consider edges where both endpoints exist in our node set (file/config/document)
const validEdges = edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target));

// --- A & B: Fan-in / Fan-out ---
const fanIn = new Map();
const fanOut = new Map();
for (const n of nodes) {
  fanIn.set(n.id, 0);
  fanOut.set(n.id, 0);
}
for (const e of validEdges) {
  fanOut.set(e.source, (fanOut.get(e.source) || 0) + 1);
  fanIn.set(e.target, (fanIn.get(e.target) || 0) + 1);
}

const fanInRanking = [...fanIn.entries()]
  .map(([id, count]) => ({ id, fanIn: count, name: nodeById.get(id).name }))
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 20);

const fanOutRanking = [...fanOut.entries()]
  .map(([id, count]) => ({ id, fanOut: count, name: nodeById.get(id).name }))
  .sort((a, b) => b.fanOut - a.fanOut)
  .slice(0, 20);

// --- C: Entry point candidates ---
const ENTRY_FILENAMES = new Set([
  'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
  'server.ts', 'server.js', 'mod.rs', 'main.go', 'main.py', 'main.rs',
  'manage.py', 'app.py', 'wsgi.py', 'asgi.py', 'run.py', '__main__.py',
  'Application.java', 'Main.java', 'Program.cs', 'config.ru', 'index.php',
  'App.swift', 'Application.kt', 'main.cpp', 'main.c',
]);

const fanOutValues = [...fanOut.values()].sort((a, b) => b - a);
const fanInValues = [...fanIn.values()].sort((a, b) => a - b);
function percentileThreshold(sortedDesc, pct) {
  if (sortedDesc.length === 0) return 0;
  const idx = Math.floor(sortedDesc.length * pct);
  return sortedDesc[Math.min(idx, sortedDesc.length - 1)];
}
const top10PctFanOutThreshold = percentileThreshold(fanOutValues, 0.10);
const bottom25PctFanInThreshold = percentileThreshold(fanInValues, 0.25);

function depthOfPath(filePath) {
  if (!filePath) return 99;
  const parts = filePath.split('/').filter(Boolean);
  return parts.length;
}

const entryScores = [];
for (const n of nodes) {
  let score = 0;
  const fp = n.filePath || '';
  const base = path.basename(fp || n.name || '');
  if (n.type === 'document') {
    if (base === 'README.md' && depthOfPath(fp) <= 1) {
      score += 5;
    } else if (base.endsWith('.md') && depthOfPath(fp) <= 1) {
      score += 2;
    }
  } else if (n.type === 'file') {
    if (ENTRY_FILENAMES.has(base)) score += 3;
    if (depthOfPath(fp) <= 2) score += 1;
    if ((fanOut.get(n.id) || 0) >= top10PctFanOutThreshold && (fanOut.get(n.id) || 0) > 0) score += 1;
    if ((fanIn.get(n.id) || 0) <= bottom25PctFanInThreshold) score += 1;
  }
  if (score > 0) {
    entryScores.push({ id: n.id, score, name: n.name, summary: n.summary || '' });
  }
}
entryScores.sort((a, b) => b.score - a.score);
const entryPointCandidates = entryScores.slice(0, 5);

// --- D: BFS from top code entry point ---
// Skip documentation nodes for BFS start; find first non-document candidate
let bfsStart = null;
for (const cand of entryPointCandidates) {
  const n = nodeById.get(cand.id);
  if (n && n.type !== 'document') {
    bfsStart = cand.id;
    break;
  }
}
// Fallback: highest fan-out file node
if (!bfsStart) {
  const nonDocSortedByFanOut = [...fanOut.entries()]
    .filter(([id]) => nodeById.get(id).type !== 'document')
    .sort((a, b) => b[1] - a[1]);
  if (nonDocSortedByFanOut.length > 0) bfsStart = nonDocSortedByFanOut[0][0];
}

const adjacency = new Map();
for (const n of nodes) adjacency.set(n.id, []);
for (const e of validEdges) {
  if (e.type === 'imports' || e.type === 'calls') {
    adjacency.get(e.source).push(e.target);
  }
}

const bfsTraversal = { startNode: bfsStart, order: [], depthMap: {}, byDepth: {} };
if (bfsStart) {
  const visited = new Set([bfsStart]);
  const queue = [[bfsStart, 0]];
  let qi = 0;
  while (qi < queue.length) {
    const [cur, depth] = queue[qi++];
    bfsTraversal.order.push(cur);
    bfsTraversal.depthMap[cur] = depth;
    if (!bfsTraversal.byDepth[depth]) bfsTraversal.byDepth[depth] = [];
    bfsTraversal.byDepth[depth].push(cur);
    const neighbors = adjacency.get(cur) || [];
    for (const nb of neighbors) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([nb, depth + 1]);
      }
    }
  }
}

// --- E: Non-code file inventory ---
const nonCodeFiles = {
  documentation: [],
  infrastructure: [],
  data: [],
  config: [],
};
for (const n of nodes) {
  const entry = { id: n.id, name: n.name, type: n.type, summary: n.summary || '' };
  if (n.type === 'document') {
    nonCodeFiles.documentation.push(entry);
  } else if (n.type === 'service' || n.type === 'pipeline' || n.type === 'resource') {
    nonCodeFiles.infrastructure.push(entry);
  } else if (n.type === 'table' || n.type === 'schema' || n.type === 'endpoint') {
    nonCodeFiles.data.push(entry);
  } else if (n.type === 'config') {
    nonCodeFiles.config.push(entry);
  }
}

// --- F: Tightly coupled clusters ---
const edgeKey = (a, b) => a + '|||' + b;
const edgeSet = new Set();
for (const e of validEdges) {
  if (e.type === 'imports' || e.type === 'calls' || e.type === 'related' || e.type === 'depends_on') {
    edgeSet.add(edgeKey(e.source, e.target));
  }
}

const bidirectionalPairs = [];
for (const e of validEdges) {
  if (e.type !== 'imports' && e.type !== 'calls') continue;
  if (edgeSet.has(edgeKey(e.target, e.source)) && e.source !== e.target) {
    bidirectionalPairs.push([e.source, e.target]);
  }
}

// Union-find to seed clusters from bidirectional pairs
const parent = new Map();
function find(x) {
  if (!parent.has(x)) parent.set(x, x);
  let root = x;
  while (parent.get(root) !== root) root = parent.get(root);
  let cur = x;
  while (parent.get(cur) !== root) {
    const next = parent.get(cur);
    parent.set(cur, root);
    cur = next;
  }
  return root;
}
function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
}
for (const [a, b] of bidirectionalPairs) {
  union(a, b);
}

const clusterMap = new Map();
for (const [a, b] of bidirectionalPairs) {
  const root = find(a);
  if (!clusterMap.has(root)) clusterMap.set(root, new Set());
  clusterMap.get(root).add(a);
  clusterMap.get(root).add(b);
}

// Expand clusters: add nodes connecting to 2+ existing members (via any of the edge types considered)
const allRelevantEdges = validEdges.filter(
  (e) => e.type === 'imports' || e.type === 'calls' || e.type === 'related' || e.type === 'depends_on'
);
for (const [root, memberSet] of clusterMap.entries()) {
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5 && memberSet.size < 5) {
    changed = false;
    iterations++;
    const connectCount = new Map();
    for (const e of allRelevantEdges) {
      const sIn = memberSet.has(e.source);
      const tIn = memberSet.has(e.target);
      if (sIn && !tIn) {
        connectCount.set(e.target, (connectCount.get(e.target) || 0) + 1);
      } else if (tIn && !sIn) {
        connectCount.set(e.source, (connectCount.get(e.source) || 0) + 1);
      }
    }
    for (const [candidate, count] of connectCount.entries()) {
      if (count >= 2 && memberSet.size < 5) {
        memberSet.add(candidate);
        changed = true;
      }
    }
  }
}

function countEdgesWithin(memberSet) {
  let c = 0;
  for (const e of validEdges) {
    if (memberSet.has(e.source) && memberSet.has(e.target) && e.source !== e.target) c++;
  }
  return c;
}

let clusters = [...clusterMap.values()]
  .map((s) => ({ nodes: [...s], edgeCount: countEdgesWithin(s) }))
  .filter((c) => c.nodes.length >= 2 && c.nodes.length <= 5)
  .sort((a, b) => b.edgeCount - a.edgeCount)
  .slice(0, 10);

// Dedup identical clusters
const seenClusterKeys = new Set();
clusters = clusters.filter((c) => {
  const key = [...c.nodes].sort().join(',');
  if (seenClusterKeys.has(key)) return false;
  seenClusterKeys.add(key);
  return true;
});

// --- G: Layer list ---
const layersOut = {
  count: layers.length,
  list: layers.map((l) => ({ id: l.id, name: l.name, description: l.description })),
};

// --- H: Node summary index ---
const nodeSummaryIndex = {};
for (const n of nodes) {
  nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary || '' };
}

const result = {
  scriptCompleted: true,
  entryPointCandidates,
  fanInRanking,
  fanOutRanking,
  bfsTraversal,
  nonCodeFiles,
  clusters,
  layers: layersOut,
  nodeSummaryIndex,
  totalNodes: nodes.length,
  totalEdges: validEdges.length,
};

try {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
} catch (e) {
  fail('Failed to write output file: ' + e.message);
}

console.log('Analysis complete. Wrote results to ' + outputPath);
process.exit(0);
