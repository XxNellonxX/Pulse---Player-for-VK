import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createServer } from 'vite';

// Offline only. Re-run production matching against retained public metadata;
// never search the network or modify source bindings/profile/library.
const input=path.resolve(process.argv[2]||'qa/library-source-audit-results.json');
const output=path.resolve(process.argv[3]||'qa/library-source-rerank-results.json');
assert.ok(input.startsWith(path.resolve('qa')+path.sep)&&output.startsWith(path.resolve('qa')+path.sep)&&output.endsWith('.json'));
const original=JSON.parse(await readFile(input,'utf8'));
const hash=createHash('sha256').update(await readFile('src/shared/sourceMatching.ts')).digest('hex');
const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
const {rankSoundCloudCandidates}=await vite.ssrLoadModule('/src/shared/sourceMatching.ts');await vite.close();
const rows=original.rows.filter(row=>row.search?.completed&&Array.isArray(row.search.candidates)).map(row=>{
  const result=rankSoundCloudCandidates(row,row.search.candidates,{preferExplicit:original.settings.preferExplicit});
  const exact=result.candidates.filter(item=>item.quality==='exact'),plausible=result.candidates.filter(item=>item.quality==='review');
  const status=exact.length===1?'unique-observed-metadata-match':exact.length>1?'multiple-exact-recordings':plausible.length?'review-required':'no-observed-match';
  return {index:row.index,id:row.id,title:row.title,artist:row.artist,duration:row.duration,baseline:row.search.status,current:status,changed:row.search.status!==status,baselineSourceHash:row.search.sourceHashes?.['src/shared/sourceMatching.ts']||null,allObservedCandidatesRetained:row.search.retainedAllCandidates===true,originalCandidateCount:row.search.candidateCount,rerankedCandidateCount:row.search.candidates.length,candidates:result.candidates.slice(0,6).map(item=>({id:item.candidate.id,title:item.candidate.title,artist:item.candidate.artist,duration:item.candidate.duration,quality:item.quality,reasons:item.reasons,durationDifference:item.durationDifference}))};
});
const count=values=>values.reduce((result,value)=>(result[value]=(result[value]||0)+1,result),{});
const report={at:new Date().toISOString(),matcherHash:hash,snapshot:original.snapshot,network:false,readOnlyProfile:true,limits:['Offline observed metadata only, no playback/fingerprint verification',...(rows.some(row=>!row.allObservedCandidatesRetained)?['Early rows with only top6 retained cannot support complete search ambiguity assessment']:[]),'Rerank of saved candidates does not repeat query generation/search pagination'],summary:{reranked:rows.length,completeCandidateRows:rows.filter(row=>row.allObservedCandidatesRetained).length,changed:rows.filter(row=>row.changed).length,baseline:count(rows.map(row=>row.baseline)),current:count(rows.map(row=>row.current))},rows};
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary:report.summary,matcherHash:hash,changed:rows.filter(row=>row.changed).map(({index,title,baseline,current,allObservedCandidatesRetained})=>({index,title,baseline,current,allObservedCandidatesRetained})),output}));
