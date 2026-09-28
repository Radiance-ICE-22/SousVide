#!/usr/bin/env node
'use strict';
const fs = require('fs');

function main() {
  const inPath = process.argv[2], outPath = process.argv[3];
  if (!inPath || !outPath) throw new Error('usage: script <input.json> <output.json>');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const fileNodes = data.fileNodes || [];
  const importEdges = data.importEdges || [];
  const allEdges = data.allEdges || [];

  const byId = new Map();
  for (const n of fileNodes) byId.set(n.id, n);
  const fileIds = new Set(byId.keys());

  const paths = fileNodes.map(n => n.filePath || '');

  // ---- A. common prefix (directory-wise) ----
  function commonDirPrefix(ps) {
    if (ps.length < 2) return '';
    const split = ps.map(p => p.split('/'));
    const out = [];
    for (let i = 0; i < split[0].length - 1; i++) {
      const seg = split[0][i];
      if (split.every(s => s.length > i + 1 && s[i] === seg)) out.push(seg); else break;
    }
    return out.length ? out.join('/') + '/' : '';
  }
  const prefix = commonDirPrefix(paths);

  const hasSubdirs = paths.some(p => p.slice(prefix.length).includes('/'));
  function groupOf(n) {
    const p = (n.filePath || '');
    const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
    const parts = rel.split('/');
    if (parts.length > 1) return parts[0];
    if (!hasSubdirs) {
      const base = parts[0];
      if (/\.(test|spec)\./.test(base) || /^test_/.test(base)) return 'test';
      if (/\.config\./.test(base) || /\.(json|ya?ml|toml|ini|cfg)$/.test(base)) return 'config';
      return 'root';
    }
    return '(root)';
  }

  const directoryGroups = {};
  const groupByNode = new Map();
  for (const n of fileNodes) {
    const g = groupOf(n);
    groupByNode.set(n.id, g);
    (directoryGroups[g] = directoryGroups[g] || []).push(n.id);
  }

  // ---- B. node type groups ----
  const nodeTypeGroups = {};
  for (const n of fileNodes) (nodeTypeGroups[n.type] = nodeTypeGroups[n.type] || []).push(n.id);

  // ---- C. adjacency, fan-in/out ----
  const fileFanIn = {}, fileFanOut = {};
  const adjacency = {};
  for (const e of importEdges) {
    if (!fileIds.has(e.source) || !fileIds.has(e.target)) continue;
    (adjacency[e.source] = adjacency[e.source] || []).push(e.target);
    fileFanOut[e.source] = (fileFanOut[e.source] || 0) + 1;
    fileFanIn[e.target] = (fileFanIn[e.target] || 0) + 1;
  }

  // ---- D. cross-category dependency analysis ----
  const ccMap = new Map();
  const nonCodeLinks = [];
  for (const e of allEdges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    const k = s.type + '|' + t.type + '|' + e.type;
    ccMap.set(k, (ccMap.get(k) || 0) + 1);
    if (s.type !== 'file' && t.type === 'file') nonCodeLinks.push({ from: e.source, to: e.target, edgeType: e.type });
  }
  const crossCategoryEdges = [...ccMap.entries()].map(([k, count]) => {
    const [fromType, toType, edgeType] = k.split('|');
    return { fromType, toType, edgeType, count };
  }).sort((a, b) => b.count - a.count);

  // ---- E/F/K. inter-group imports, intra-group density, direction ----
  const pairCount = new Map();
  const groupTotal = {}, groupInternal = {};
  for (const g of Object.keys(directoryGroups)) { groupTotal[g] = 0; groupInternal[g] = 0; }
  for (const e of importEdges) {
    const gs = groupByNode.get(e.source), gt = groupByNode.get(e.target);
    if (gs === undefined || gt === undefined) continue;
    const k = gs + '|' + gt;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
    if (gs === gt) { groupInternal[gs]++; groupTotal[gs]++; }
    else { groupTotal[gs]++; groupTotal[gt]++; }
  }
  const interGroupImports = [...pairCount.entries()].map(([k, count]) => {
    const [from, to] = k.split('|'); return { from, to, count };
  }).sort((a, b) => b.count - a.count);

  const intraGroupDensity = {};
  for (const g of Object.keys(directoryGroups)) {
    const tot = groupTotal[g], int = groupInternal[g];
    intraGroupDensity[g] = { internalEdges: int, totalEdges: tot, density: tot ? +(int / tot).toFixed(3) : 0 };
  }

  const dependencyDirection = [];
  const seenPair = new Set();
  for (const { from, to } of interGroupImports) {
    if (from === to) continue;
    const key = [from, to].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const a = pairCount.get(from + '|' + to) || 0;
    const b = pairCount.get(to + '|' + from) || 0;
    if (a >= b) dependencyDirection.push({ dependent: from, dependsOn: to, weight: a, reverse: b });
    else dependencyDirection.push({ dependent: to, dependsOn: from, weight: b, reverse: a });
  }

  // ---- G. pattern matching ----
  const DIR_PATTERNS = [
    [['routes','api','controllers','endpoints','handlers','serializers','routers','blueprints','controller'], 'api'],
    [['services','core','lib','domain','logic','signals','composables','mailers','jobs','channels','internal'], 'service'],
    [['models','db','data','persistence','repository','entities','migrations','entity','sql','database','schema'], 'data'],
    [['components','views','pages','ui','layouts','screens'], 'ui'],
    [['middleware','plugins','interceptors','guards'], 'middleware'],
    [['utils','utilities','helpers','common','shared','tools','templatetags','pkg'], 'utility'],
    [['config','configs','constants','env','settings','management','commands'], 'config'],
    [['__tests__','test','tests','spec','specs'], 'test'],
    [['types','interfaces','schemas','contracts','dtos','dto','request','response'], 'types'],
    [['hooks'], 'hooks'],
    [['store','state','reducers','actions','slices'], 'state'],
    [['assets','static','public'], 'assets'],
    [['cmd','bin'], 'entry'],
    [['docs','documentation','wiki','notebooks'], 'documentation'],
    [['deploy','deployment','infra','infrastructure','k8s','kubernetes','helm','charts','terraform','tf','docker'], 'infrastructure'],
    [['.github','.gitlab','.circleci'], 'ci-cd'],
  ];
  const patternMatches = {};
  for (const g of Object.keys(directoryGroups)) {
    let label = null;
    const gl = g.toLowerCase();
    for (const [names, lab] of DIR_PATTERNS) if (names.includes(gl)) { label = lab; break; }
    patternMatches[g] = label || 'unclassified';
  }

  const filePatternMatches = {};
  for (const n of fileNodes) {
    const p = n.filePath || '', base = p.split('/').pop();
    let lab = null;
    if (/\.(test|spec)\.[^.]+$/.test(base) || /^test_.*\.py$/.test(base) || /_test\.go$/.test(base) || /Test\.java$/.test(base) || /_spec\.rb$/.test(base) || /Tests?\.(php|cs)$/.test(base)) lab = 'test';
    else if (/\.d\.ts$/.test(base)) lab = 'types';
    else if (/^(Dockerfile|Makefile)/.test(base) || /^docker-compose\./.test(base) || /\.tfvars?$/.test(base) || /\.tf$/.test(base)) lab = 'infrastructure';
    else if (/^(\.gitlab-ci\.yml|Jenkinsfile)$/.test(base) || /^\.github\/workflows\//.test(p)) lab = 'ci-cd';
    else if (/\.sql$/.test(base)) lab = 'data';
    else if (/\.(graphql|gql|proto|prisma)$/.test(base)) lab = 'types';
    else if (/\.(md|rst)$/.test(base)) lab = 'documentation';
    else if (/^(Cargo\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle|composer\.json|pyproject\.toml|package\.json|setup\.py|setup\.cfg)$/.test(base) || /^environment.*\.ya?ml$/.test(base)) lab = 'config';
    else if (/^(wsgi|asgi)\.py$/.test(base)) lab = 'config';
    else if (/^(manage\.py|main\.go|main\.rs|lib\.rs|Application\.java|Program\.cs|config\.ru)$/.test(base)) lab = 'entry';
    else if (/^(index\.(ts|js)|__init__\.py)$/.test(base)) lab = 'entry';
    else if (/\.ipynb$/.test(base)) lab = 'documentation';
    if (lab) filePatternMatches[n.id] = lab;
  }

  // ---- H. deployment topology ----
  const infraFiles = [];
  let hasDockerfile = false, hasCompose = false, hasK8s = false, hasTerraform = false, hasCI = false;
  for (const p of paths) {
    const base = p.split('/').pop();
    if (/^Dockerfile/.test(base)) { hasDockerfile = true; infraFiles.push(p); }
    else if (/^docker-compose/.test(base)) { hasCompose = true; infraFiles.push(p); }
    else if (/\.tf$|\.tfvars$/.test(base)) { hasTerraform = true; infraFiles.push(p); }
    else if (/^(k8s|kubernetes|helm|charts)\//.test(p)) { hasK8s = true; infraFiles.push(p); }
    else if (/^\.github\/workflows\//.test(p) || /^(\.gitlab-ci\.yml|Jenkinsfile)$/.test(base)) { hasCI = true; infraFiles.push(p); }
    else if (/^Makefile$/.test(base)) { infraFiles.push(p); }
  }

  // ---- I. data pipeline ----
  const dataPipeline = { schemaFiles: [], migrationFiles: [], dataModelFiles: [], apiHandlerFiles: [] };
  for (const n of fileNodes) {
    const p = n.filePath || '', tags = (n.tags || []).join(',');
    if (/\.(sql|graphql|gql|proto|prisma)$/.test(p) || /schema-definition/.test(tags)) dataPipeline.schemaFiles.push(p);
    if (/migrations?\//.test(p)) dataPipeline.migrationFiles.push(p);
    if (/\bdata-model\b/.test(tags) || /\/(models|entities)\//.test(p)) dataPipeline.dataModelFiles.push(p);
    if (/api-handler|\bendpoint\b/.test(tags) || /\/(routes|controllers|api)\//.test(p)) dataPipeline.apiHandlerFiles.push(p);
  }

  // ---- J. documentation coverage ----
  const docGroups = new Set();
  for (const n of fileNodes) {
    if (n.type === 'document' || /\.(md|rst)$/.test(n.filePath || '')) docGroups.add(groupByNode.get(n.id));
  }
  // groups referenced by document nodes via edges
  for (const e of allEdges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (s && t && (s.type === 'document' || /\.(md|rst)$/.test(s.filePath || ''))) docGroups.add(groupByNode.get(t.id));
  }
  const allGroups = Object.keys(directoryGroups);
  const undocumentedGroups = allGroups.filter(g => !docGroups.has(g));
  const docCoverage = {
    groupsWithDocs: allGroups.length - undocumentedGroups.length,
    totalGroups: allGroups.length,
    coverageRatio: allGroups.length ? +((allGroups.length - undocumentedGroups.length) / allGroups.length).toFixed(2) : 0,
    undocumentedGroups
  };

  const filesPerGroup = {}, nodeTypeCounts = {};
  for (const g of allGroups) filesPerGroup[g] = directoryGroups[g].length;
  for (const t of Object.keys(nodeTypeGroups)) nodeTypeCounts[t] = nodeTypeGroups[t].length;

  const results = {
    scriptCompleted: true,
    commonPrefix: prefix,
    directoryGroups, nodeTypeGroups, crossCategoryEdges,
    nonCodeLinkCount: nonCodeLinks.length,
    interGroupImports, intraGroupDensity, patternMatches, filePatternMatches,
    deploymentTopology: { hasDockerfile, hasCompose, hasK8s, hasTerraform, hasCI, infraFiles },
    dataPipeline, docCoverage, dependencyDirection,
    fileStats: { totalFileNodes: fileNodes.length, filesPerGroup, nodeTypeCounts },
    fileFanIn, fileFanOut
  };
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('OK groups=' + allGroups.length + ' nodes=' + fileNodes.length);
}
try { main(); } catch (err) { console.error(err && err.stack || String(err)); process.exit(1); }
