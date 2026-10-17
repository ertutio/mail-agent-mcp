// Archived analysis script: historical workspace layout required; not a product/CI entry.
// Artifact validation only; does not execute product code, build, tests, or services.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const out=path.dirname(fileURLToPath(import.meta.url));
const workspace=path.resolve(out,'../..');
const repo=path.join(workspace,'work/mail-agent-audit'),root=path.join(workspace,'work/mail-agent-understand-20261017'),ua=path.join(root,'.ua');
const read=p=>JSON.parse(fs.readFileSync(path.join(ua,p),'utf8'));
const save=(p,o)=>fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n');
const graph=read('knowledge-graph.json'),coverage=read('coverage.json'),scan=read('intermediate/scan-result.json');
const issues=[],warnings=[],ids=new Set(),assigned=new Set();
for(const n of graph.nodes){
 if(!n.id||!n.type||!n.name||!n.summary||!n.tags?.length)issues.push('Missing node field: '+n.id);
 if(ids.has(n.id))issues.push('Duplicate node: '+n.id);ids.add(n.id);
 if(n.filePath&&!fs.existsSync(path.join(root,n.filePath)))issues.push('Missing source file: '+n.filePath);
 if(n.lineRange){const lines=fs.readFileSync(path.join(root,n.filePath),'utf8').split('\n').length;if(n.lineRange[0]<1||n.lineRange[1]>lines||n.lineRange[0]>n.lineRange[1])issues.push('Invalid line range: '+n.id);}
}
for(const e of graph.edges)if(!ids.has(e.source)||!ids.has(e.target))issues.push('Dangling edge: '+e.source+' -> '+e.target);
for(const l of graph.layers){if(!l.id||!l.name||!l.description||!Array.isArray(l.nodeIds))issues.push('Layer shape');for(const id of l.nodeIds){if(!ids.has(id))issues.push('Missing layer ref '+id);if(assigned.has(id))issues.push('Repeated layer assignment '+id);assigned.add(id);}}
const fileTypes=new Set(['file','config','document','service','pipeline','table','schema','resource','endpoint']);
for(const n of graph.nodes.filter(n=>fileTypes.has(n.type)))if(!assigned.has(n.id))issues.push('Unassigned file '+n.id);
for(const f of scan.files){if(!coverage.files.some(c=>c.path===f.path))issues.push('Missing coverage: '+f.path);if(!graph.nodes.some(n=>n.filePath===f.path&&fileTypes.has(n.type)))issues.push('Missing file node: '+f.path);}
const modules=read('module-index.json').modules;
for(const f of scan.files.filter(f=>f.path.startsWith('src/')))if(!modules.some(m=>m.path===f.path&&m.role&&Array.isArray(m.dependencies)))issues.push('Missing production module '+f.path);
const raw=read('tmp/structure.json');
if(raw.filesUnreadable.length||!raw.scriptCompleted)issues.push('Incomplete structure');
warnings.push('Unsupported structural parser: '+raw.filesSkipped.join(', '));
warnings.push('No whole-program call resolution or whole-file semantic audit; see per-file readingDepth.');
if(graph.tour.length!==0)issues.push('Tour was meant to be skipped');
const fingerprints=read('fingerprints.json');
// Supported versions use {version, gitCommitHash, files}; retain only scoped count check.
const fpEntries=fingerprints.files??fingerprints.fingerprints??fingerprints;
for(const f of scan.files)if(!Object.hasOwn(fpEntries,f.path))issues.push('Missing fingerprint '+f.path);
const graphStats={nodes:graph.nodes.length,edges:graph.edges.length,layers:graph.layers.length,files:scan.files.length,productionModules:modules.length,tourSteps:0};
save(path.join(ua,'intermediate/review.json'),{issues:[...issues],warnings,stats:graphStats,meaning:'Deterministic structure/reference validation only; not runtime correctness.'});

const body=fs.readFileSync(path.join(out,'ROADMAP-PR-BODY.md'),'utf8');
const audit=JSON.parse(fs.readFileSync(path.join(root,'docs/audits/supplied-audit-findings-2026-10-15.json'),'utf8'));
const originals=[...audit.findings.map(f=>f.id),'SA-08'];
const mappings=body.split('\n').filter(l=>/^\| (?:SA-|SEC-|MAIL-|BUG-SEC-|ENG-)\S* \/ /.test(l)).map(l=>{
 const c=l.split('|').slice(1,-1).map(s=>s.trim());return {id:c[0].split(' / ')[0],originalPriority:c[0].split(' / ')[1],originalTask:c[0].split(' / ')[2],statusAndEvidence:c[1],disposition:c[2],acceptanceAndDependencies:c[3],tasks:[...new Set((c[2]+' '+c[3]).match(/T\d{2}/g)||[])]};
});
for(const id of originals)if(mappings.filter(m=>m.id===id).length!==1)issues.push('Original missing/duplicated '+id);
for(const m of mappings)if(!originals.includes(m.id))issues.push('Unknown original '+m.id);
const tasks=body.split('\n').filter(l=>/^\| T\d{2} \|/.test(l)).map(l=>{const c=l.split('|').slice(1,-1).map(s=>s.trim());return {id:c[0],goal:c[1],dependencies:c[2].match(/T\d{2}/g)||[],gate:c[2],acceptance:c[3]};});
tasks.unshift({id:'T01',goal:'MAIL-01: folder_status obeys mailbox lock',dependencies:[],gate:'None',acceptance:'See next-task contract and deterministic concurrent read/flags/move/delete regression in ROADMAP-PR-BODY.md.'});
const taskIds=new Set(tasks.map(t=>t.id));
if(taskIds.size!==tasks.length)issues.push('Duplicate task ID');
for(const m of mappings)for(const id of m.tasks)if(!taskIds.has(id))issues.push('Unknown mapped task '+id);
for(const t of tasks)for(const d of t.dependencies)if(!taskIds.has(d))issues.push('Missing dependency '+d);
const stack=new Set(),visited=new Set(),byId=new Map(tasks.map(t=>[t.id,t]));
function visit(id){if(stack.has(id)){issues.push('Dependency cycle '+id);return;}if(visited.has(id))return;stack.add(id);for(const d of byId.get(id)?.dependencies||[])visit(d);stack.delete(id);visited.add(id);}
tasks.forEach(t=>visit(t.id));
const riskFeatureIds=[...Array.from({length:5},(_,i)=>'R'+(i+1)),...Array.from({length:8},(_,i)=>'F'+(i+1))];
for(const id of riskFeatureIds)if(!new RegExp('^\\| '+id+' \\|','m').test(body))issues.push('Missing risk/feature '+id);
save(path.join(out,'roadmap-index.json'),{derivedFrom:'ROADMAP-PR-BODY.md; narrative is authoritative; regenerate this index after edits',commit:graph.project.gitCommitHash,nextTask:'T01',oneTaskPerTurn:true,stopAfterAcceptance:true,mappings,tasks,riskFeatureIds});

const tests=scan.files.filter(f=>f.path.startsWith('tests/')).map(f=>{
 const source=fs.readFileSync(path.join(root,f.path),'utf8');
 const titles=source.split('\n').flatMap((l,i)=>{const m=l.match(/\b(?:it|test|describe)(?:\.(?:each|skip|only)\([^)]*\))?\s*\(\s*(['"`])(.*?)\1/);return m?[{line:i+1,title:m[2]}]:[];});
 return {file:f.path,internalImports:scan.importMap[f.path]||[],staticTitles:titles,limitation:'String/title index only; may omit dynamic each titles. Not an executed test count.',execution:'not-run-this-turn'};
});
save(path.join(ua,'test-index.json'),{commit:graph.project.gitCommitHash,testFiles:tests.length,tests});
const tracked=execFileSync('git',['-C',repo,'ls-tree','-r',graph.project.gitCommitHash],{encoding:'utf8'}).trim().split('\n').map(l=>{const [m,p]=l.split('\t');return {file:p,blob:m.split(' ')[2]};});
let normalizedMatches=0,exactMatches=0;
const blobHash=b=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b])).digest('hex');
for(const f of tracked){const b=fs.readFileSync(path.join(root,f.file));if(blobHash(b)===f.blob){exactMatches++;continue;}
 const normalized=Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));
 if(blobHash(normalized)===f.blob)normalizedMatches++;else issues.push('Snapshot Git blob mismatch after line-ending normalization '+f.file);
}
const status=execFileSync('git',['-C',repo,'status','--porcelain=v1'],{encoding:'utf8'}).trim();
if(status)issues.push('Original checkout became dirty: '+status);
const planBlob=tracked.find(f=>f.file==='docs/plans/audit-remediation-2026-10-15.md')?.blob;
const relevant=/^(BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:DEEPSEEK|ANTHROPIC|OPENAI)_API_KEY\s*=\s*[^\s*]+|AIza[A-Za-z0-9_-]{25,})/m;
const reportFiles=fs.readdirSync(out).filter(f=>/\.(?:md|json|mts|mjs)$/.test(f));
for(const f of reportFiles){const p=path.join(out,f);const txt=fs.readFileSync(p,'utf8');if(relevant.test(txt))issues.push('Potential secret pattern in '+f);if(f.endsWith('.json')){try{JSON.parse(txt);}catch{issues.push('Invalid JSON '+f);}}}
// Check only Markdown file links; relative source paths remain portable inside this workspace.
for(const f of reportFiles.filter(f=>f.endsWith('.md'))){const txt=fs.readFileSync(path.join(out,f),'utf8');for(const m of txt.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const dest=m[1];if(/^(https?:|#)/.test(dest))continue;const local=dest.split('#')[0];if(local&&!fs.existsSync(path.resolve(out,local)))issues.push('Broken link '+f+' -> '+dest);}}
if(!issues.length)save(path.join(ua,'meta.json'),{lastAnalyzedAt:graph.project.analyzedAt,gitCommitHash:graph.project.gitCommitHash,remoteMainCommit:graph.analysis.remoteMainCommit,tree:graph.analysis.tree,version:'1.0.0',analyzedFiles:scan.files.length,scope:'frozen-snapshot/retrieval; dashboard and tour omitted; fingerprints succeeded; not configured for automatic update'});
const result={validatedAt:new Date().toISOString(),success:issues.length===0,issues,warnings,graph:graphStats,originalFindings:originals.length,mappedFindings:mappings.length,tasks:tasks.length,dependencyCycles:issues.filter(s=>s.startsWith('Dependency cycle')),riskFeatures:riskFeatureIds.length,testFiles:tests.length,snapshotBlobsCompared:tracked.length,snapshotExactBlobMatches:exactMatches,snapshotMatchesAfterCrlfToLfNormalization:normalizedMatches,originalCheckoutClean:!status,originalPlanBlob:planBlob,businessSourceModified:false,testsBuildAndDeploymentExecutedByValidator:false};
save(path.join(out,'analysis-validation.json'),result);
console.log(JSON.stringify(result,null,2));
if(issues.length)process.exitCode=1;
