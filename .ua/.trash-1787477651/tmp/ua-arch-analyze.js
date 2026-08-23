#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  fail('Usage: node ua-arch-analyze.js <input.json> <output.json>');
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  fail('Failed to read/parse input JSON: ' + e.message);
}

const fileNodes = data.fileNodes || [];
const importEdges = data.importEdges || [];
const allEdges = data.allEdges || [];

const nodeById = new Map();
for (const n of fileNodes) nodeById.set(n.id, n);

// ---------- A. Directory Grouping ----------
function dirSegments(fp) {
  return fp.split('/').filter(Boolean);
}

const allPaths = fileNodes.map(n => n.filePath || n.name || '');

function commonPrefix(paths) {
  if (paths.length === 0) return '';
  const splitPaths = paths.map(p => dirSegments(p).slice(0, -1)); // dirs only
  let prefix = splitPaths[0];
  for (let i = 1; i < splitPaths.length; i++) {
    const cur = splitPaths[i];
    let j = 0;
    while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) break;
  }
  return prefix;
}

const prefixSegs = commonPrefix(allPaths);

function groupForPath(fp) {
  const segs = dirSegments(fp);
  const dirs = segs.slice(0, -1);
  const fileName = segs[segs.length - 1] || fp;
  // strip common prefix
  let rest = dirs;
  if (prefixSegs.length > 0 && dirs.length >= prefixSegs.length) {
    let matches = true;
    for (let i = 0; i < prefixSegs.length; i++) {
      if (dirs[i] !== prefixSegs[i]) { matches = false; break; }
    }
    if (matches) rest = dirs.slice(prefixSegs.length);
  }
  if (rest.length > 0) {
    return rest[0];
  }
  // flat structure: group root-level files by directory (if any) else by extension pattern
  if (dirs.length > 0) {
    return dirs[0];
  }
  // truly root file - group by extension/pattern
  if (/\.test\.|\.spec\./.test(fileName)) return 'test';
  if (/\.config\./.test(fileName)) return 'config';
  const ext = fileName.includes('.') ? fileName.split('.').pop() : 'noext';
  return 'root-' + ext;
}

const directoryGroups = {};
for (const n of fileNodes) {
  const g = groupForPath(n.filePath || n.name || '');
  if (!directoryGroups[g]) directoryGroups[g] = [];
  directoryGroups[g].push(n.id);
}

// ---------- B. Node Type Grouping ----------
const nodeTypeGroups = {};
for (const n of fileNodes) {
  const t = n.type || 'file';
  if (!nodeTypeGroups[t]) nodeTypeGroups[t] = [];
  nodeTypeGroups[t].push(n.id);
}

// ---------- C. Import Adjacency Matrix ----------
const fanOut = {};
const fanIn = {};
for (const n of fileNodes) { fanOut[n.id] = 0; fanIn[n.id] = 0; }
const idToGroup = {};
for (const [g, ids] of Object.entries(directoryGroups)) {
  for (const id of ids) idToGroup[id] = g;
}

for (const e of importEdges) {
  if (nodeById.has(e.source)) fanOut[e.source] = (fanOut[e.source] || 0) + 1;
  if (nodeById.has(e.target)) fanIn[e.target] = (fanIn[e.target] || 0) + 1;
}

// ---------- D. Cross-Category Dependency Analysis ----------
const crossCategoryMap = new Map();
for (const e of allEdges) {
  const sNode = nodeById.get(e.source);
  const tNode = nodeById.get(e.target);
  if (!sNode || !tNode) continue;
  if (sNode.type === tNode.type && sNode.type === 'file') continue; // handled elsewhere, but keep general
  const key = sNode.type + '|' + tNode.type + '|' + e.type;
  crossCategoryMap.set(key, (crossCategoryMap.get(key) || 0) + 1);
}
const crossCategoryEdges = [];
for (const [key, count] of crossCategoryMap.entries()) {
  const [fromType, toType, edgeType] = key.split('|');
  crossCategoryEdges.push({ fromType, toType, edgeType, count });
}

// ---------- E. Inter-Group Import Frequency ----------
const interGroupMap = new Map();
for (const e of importEdges) {
  const gFrom = idToGroup[e.source];
  const gTo = idToGroup[e.target];
  if (!gFrom || !gTo) continue;
  if (gFrom === gTo) continue;
  const key = gFrom + '|' + gTo;
  interGroupMap.set(key, (interGroupMap.get(key) || 0) + 1);
}
const interGroupImports = [];
for (const [key, count] of interGroupMap.entries()) {
  const [from, to] = key.split('|');
  interGroupImports.push({ from, to, count });
}

// ---------- F. Intra-Group Import Density ----------
const intraGroupDensity = {};
for (const g of Object.keys(directoryGroups)) {
  let internalEdges = 0;
  let totalEdges = 0;
  for (const e of importEdges) {
    const gFrom = idToGroup[e.source];
    const gTo = idToGroup[e.target];
    if (gFrom === g || gTo === g) {
      totalEdges++;
      if (gFrom === g && gTo === g) internalEdges++;
    }
  }
  intraGroupDensity[g] = {
    internalEdges,
    totalEdges,
    density: totalEdges > 0 ? internalEdges / totalEdges : 0
  };
}

// ---------- G. Directory Pattern Matching ----------
const dirPatternTable = [
  { pats: ['routes', 'api', 'controllers', 'endpoints', 'handlers'], label: 'api' },
  { pats: ['services', 'core', 'lib', 'domain', 'logic'], label: 'service' },
  { pats: ['models', 'db', 'data', 'persistence', 'repository', 'entities'], label: 'data' },
  { pats: ['components', 'views', 'pages', 'ui', 'layouts', 'screens'], label: 'ui' },
  { pats: ['middleware', 'plugins', 'interceptors', 'guards'], label: 'middleware' },
  { pats: ['utils', 'helpers', 'common', 'shared', 'tools'], label: 'utility' },
  { pats: ['config', 'constants', 'env', 'settings'], label: 'config' },
  { pats: ['__tests__', 'test', 'tests', 'spec', 'specs'], label: 'test' },
  { pats: ['types', 'interfaces', 'schemas', 'contracts', 'dtos'], label: 'types' },
  { pats: ['hooks'], label: 'hooks' },
  { pats: ['store', 'state', 'reducers', 'actions', 'slices'], label: 'state' },
  { pats: ['assets', 'static', 'public'], label: 'assets' },
  { pats: ['migrations'], label: 'data' },
  { pats: ['management', 'commands'], label: 'config' },
  { pats: ['templatetags'], label: 'utility' },
  { pats: ['signals'], label: 'service' },
  { pats: ['serializers'], label: 'api' },
  { pats: ['cmd'], label: 'entry' },
  { pats: ['internal'], label: 'service' },
  { pats: ['pkg'], label: 'utility' },
  { pats: ['dto', 'request', 'response'], label: 'types' },
  { pats: ['entity'], label: 'data' },
  { pats: ['controller'], label: 'api' },
  { pats: ['routers'], label: 'api' },
  { pats: ['composables'], label: 'service' },
  { pats: ['blueprints'], label: 'api' },
  { pats: ['mailers', 'jobs', 'channels'], label: 'service' },
  { pats: ['bin'], label: 'entry' },
  { pats: ['docs', 'documentation', 'wiki'], label: 'documentation' },
  { pats: ['deploy', 'deployment', 'infra', 'infrastructure'], label: 'infrastructure' },
  { pats: ['.github', '.gitlab', '.circleci'], label: 'ci-cd' },
  { pats: ['k8s', 'kubernetes', 'helm', 'charts'], label: 'infrastructure' },
  { pats: ['terraform', 'tf'], label: 'infrastructure' },
  { pats: ['docker'], label: 'infrastructure' },
  { pats: ['sql', 'database', 'schema'], label: 'data' }
];

function patternForDir(dirName) {
  const lower = dirName.toLowerCase();
  for (const { pats, label } of dirPatternTable) {
    if (pats.includes(lower)) return label;
  }
  return null;
}

const patternMatches = {};
for (const g of Object.keys(directoryGroups)) {
  const p = patternForDir(g);
  if (p) patternMatches[g] = p;
}

// ---------- H. Deployment Topology Detection ----------
const infraFiles = [];
let hasDockerfile = false, hasCompose = false, hasK8s = false, hasTerraform = false, hasCI = false;
for (const n of fileNodes) {
  const fp = n.filePath || n.name || '';
  const base = path.basename(fp);
  if (/^Dockerfile/i.test(base)) { hasDockerfile = true; infraFiles.push(fp); }
  if (/docker-compose/i.test(base)) { hasCompose = true; infraFiles.push(fp); }
  if (/\.ya?ml$/i.test(base) && /(k8s|kubernetes)/i.test(fp)) { hasK8s = true; infraFiles.push(fp); }
  if (/\.tf$|\.tfvars$/i.test(base)) { hasTerraform = true; infraFiles.push(fp); }
  if (/^\.github\/workflows\//.test(fp) || /\.gitlab-ci\.yml$/i.test(base) || /^Jenkinsfile$/i.test(base)) {
    hasCI = true; infraFiles.push(fp);
  }
  if (/^Makefile$/i.test(base)) { infraFiles.push(fp); }
}

const deploymentTopology = {
  hasDockerfile, hasCompose, hasK8s, hasTerraform, hasCI,
  infraFiles: Array.from(new Set(infraFiles))
};

// ---------- I. Data Pipeline Detection ----------
const schemaFiles = [];
const migrationFiles = [];
const dataModelFiles = [];
const apiHandlerFiles = [];
for (const n of fileNodes) {
  const fp = n.filePath || n.name || '';
  const base = path.basename(fp);
  if (/\.sql$/i.test(base) || /\.graphql$/i.test(base) || /\.gql$/i.test(base) || /\.proto$/i.test(base)) {
    schemaFiles.push(fp);
  }
  if (/migrations\//.test(fp)) migrationFiles.push(fp);
  const g = idToGroup[n.id];
  if (g && patternMatches[g] === 'data') dataModelFiles.push(fp);
  if (g && patternMatches[g] === 'api') apiHandlerFiles.push(fp);
}

const dataPipeline = { schemaFiles, migrationFiles, dataModelFiles, apiHandlerFiles };

// ---------- J. Documentation Coverage ----------
const documentPaths = fileNodes.filter(n => n.type === 'document').map(n => n.filePath || n.name || '');
const groupsWithDocsSet = new Set();
for (const g of Object.keys(directoryGroups)) {
  const hasReadme = directoryGroups[g].some(id => {
    const n = nodeById.get(id);
    const base = path.basename(n.filePath || n.name || '');
    return /^readme/i.test(base);
  });
  const hasReferencingDoc = documentPaths.some(dp => dp.toLowerCase().includes(g.toLowerCase()));
  if (hasReadme || hasReferencingDoc) groupsWithDocsSet.add(g);
}
const totalGroups = Object.keys(directoryGroups).length;
const groupsWithDocs = groupsWithDocsSet.size;
const undocumentedGroups = Object.keys(directoryGroups).filter(g => !groupsWithDocsSet.has(g));

const docCoverage = {
  groupsWithDocs,
  totalGroups,
  coverageRatio: totalGroups > 0 ? groupsWithDocs / totalGroups : 0,
  undocumentedGroups
};

// ---------- K. Dependency Direction ----------
const dependencyDirection = [];
const seenPairs = new Set();
for (const { from, to, count } of interGroupImports) {
  const pairKey = [from, to].sort().join('|');
  if (seenPairs.has(pairKey)) continue;
  seenPairs.add(pairKey);
  const reverse = interGroupImports.find(x => x.from === to && x.to === from);
  const reverseCount = reverse ? reverse.count : 0;
  if (count > reverseCount) {
    dependencyDirection.push({ dependent: from, dependsOn: to });
  } else if (reverseCount > count) {
    dependencyDirection.push({ dependent: to, dependsOn: from });
  }
}

// ---------- File Stats ----------
const filesPerGroup = {};
for (const [g, ids] of Object.entries(directoryGroups)) filesPerGroup[g] = ids.length;
const nodeTypeCounts = {};
for (const [t, ids] of Object.entries(nodeTypeGroups)) nodeTypeCounts[t] = ids.length;

const fileStats = {
  totalFileNodes: fileNodes.length,
  filesPerGroup,
  nodeTypeCounts
};

const result = {
  scriptCompleted: true,
  directoryGroups,
  nodeTypeGroups,
  crossCategoryEdges,
  interGroupImports,
  intraGroupDensity,
  patternMatches,
  deploymentTopology,
  dataPipeline,
  docCoverage,
  dependencyDirection,
  fileStats,
  fileFanIn: fanIn,
  fileFanOut: fanOut
};

try {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
} catch (e) {
  fail('Failed to write output JSON: ' + e.message);
}

process.exit(0);
