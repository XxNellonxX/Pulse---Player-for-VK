import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';

// Read-only library audit. Only bounded sequential public metadata searches
// are permitted: never binding, uploading, modifying the profile or fetching
// audio. Reports contain library metadata and stay in ignored qa/*.json.
const args=process.argv.slice(2), option=(key,fallback)=>args.find(value=>value.startsWith(key+'='))?.slice(key.length+1)||fallback;
const live=args.includes('--live-search');
const retryErrors=args.includes('--retry-transient');
const refreshIncomplete=args.includes('--refresh-incomplete');
assert.ok(!refreshIncomplete||live,'Refreshing incomplete pools requires explicit live-search');
const limit=Number(option('--limit','800'));
assert.ok(Number.isInteger(limit)&&limit>=1&&limit<=800,'Limit must be1..800');
const minInterval=Math.max(1600,Number(option('--interval','1800')));
const maxRequests=Math.min(2400,Number(option('--max-requests','1000')));
assert.ok(Number.isFinite(minInterval)&&Number.isFinite(maxRequests)&&maxRequests>=1);
const profile=option('--profile',path.join(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'ru.vkplayer.desktop'));
const reportPath=path.resolve(option('--report','qa/library-source-audit-results.json'));
assert.ok(reportPath.startsWith(path.resolve('qa')+path.sep)&&reportPath.endsWith('.json'),'Report must stay in ignoredqaJSON');
const raw=await readFile(path.join(profile,'library.json'));
const envelope=JSON.parse(raw),state=envelope.state||envelope;
const sourceFiles=['src/sourceResolution.ts','src/shared/sourceMatching.ts'];
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async filename=>[filename,createHash('sha256').update(await readFile(filename)).digest('hex')])));
const libraryStat=await stat(path.join(profile,'library.json'));
const links=JSON.parse(await readFile(path.join(profile,'source-links.json'),'utf8').catch(()=>'[]'));
assert.ok(Array.isArray(state.tracks)&&Array.isArray(links));
const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
const {shouldSearchSoundCloud}=await vite.ssrLoadModule('/src/sourceResolution.ts');
const {normalizeRecordingText,rankSoundCloudCandidates}=await vite.ssrLoadModule('/src/shared/sourceMatching.ts');
await vite.close();
const settings={...state.settings,preferSoundCloud:state.settings?.preferSoundCloud??true,preferExplicit:state.settings?.preferExplicit??true};
const config=JSON.parse(await readFile(new URL('../config/pulse-service.default.json',import.meta.url),'utf8'));
const origin=new URL(config.gatewayUrl);assert.equal(origin.protocol,'https:');
const snapshot=createHash('sha256').update(raw).digest('hex');
const own=state.tracks.filter(track=>track.source==='vk'&&track.remote?.inLibrary===true);
const sample=own.slice(0,limit); // Native library order is VK order; do not sort by imported addedAt.
let previous;
try {previous=JSON.parse(await readFile(reportPath,'utf8'));}catch{}
const resume=previous?.snapshot===snapshot&&previous?.sampleCount===sample.length;
assert.ok(!refreshIncomplete||resume,'Refreshing candidate pools requires the same library snapshot and sample');
const refreshIds=new Set(refreshIncomplete?previous.rows.filter(row=>row.search?.completed&&row.search.retainedAllCandidates!==true).map(row=>row.id):[]);
const metadataRows=sample.map((track,index)=>{
  const catalogLinked=track.artistCard==='present'||track.artistRefs?.some(ref=>ref.id?.trim());
  const binding=links.find(link=>link.trackId===track.id)?.candidate;
  const provenance=links.find(link=>link.trackId===track.id)?.selection;
  const exactBinding=binding&&rankSoundCloudCandidates(track,[binding],{preferExplicit:settings.preferExplicit}).candidates[0]?.quality==='exact';
  const retainedOriginal=Array.isArray(envelope.files)&&envelope.files.some(file=>Array.isArray(file)&&file[0]===track.id);
  const flags=[];
  if(!normalizeRecordingText(track.title||''))flags.push('empty-title');
  if(!normalizeRecordingText(track.artist||''))flags.push('empty-artist');
  if(!(Number.isFinite(track.duration)&&track.duration>0))flags.push('unknown-duration');
  if(!track.available)flags.push('unavailable');
  if(/\p{Script=Cyrillic}/u.test(track.title)&&/[a-z]/iu.test(track.title))flags.push('mixed-script-title');
  if(/(?:feat\.?|ft\.?|,|\s+[x&×]\s+|\s+#)/iu.test(track.artist))flags.push('multi-artist-delimiters');
  if(/^[^\p{L}\p{N}]*$/u.test(track.title+track.artist))flags.push('missing-identity');
  const scPriority=shouldSearchSoundCloud(track,settings,false);
  const restored=resume?previous.rows?.find(row=>row.id===track.id):null;
  let search=restored?.search;
  if(retryErrors&&search&&/^(?:http-5\d\d|network-failure|search-timeout|search-rate-limit)/u.test(search.status))search={...search,completed:false,previousFailures:[...(search.previousFailures||[]),{status:search.status,at:search.at}]};
  return {index:index+1,id:track.id,title:track.title,artist:track.artist,duration:track.duration,version:track.version,explicit:track.explicit,isrc:track.isrc,available:track.available,artistCard:track.artistCard||'missing',artistRefsCount:track.artistRefs?.length||0,catalogLinked:Boolean(catalogLinked),scPriority,retainedOriginalRegistryEntry:retainedOriginal,savedBinding:binding?{sourceId:binding.id,title:binding.title,artist:binding.artist,duration:binding.duration,selection:provenance||'legacy-user',exact:exactBinding}:null,flags,search};
});
const count=values=>values.reduce((result,value)=>(result[value]=(result[value]||0)+1,result),{});
const report={version:1,sourcePolicyRevision:'current-source-hashes',sourceHashes,priorUnhashedSearches:metadataRows.filter(row=>row.search&&!row.search.sourceHashes).length,startedAt:previous?.startedAt||new Date().toISOString(),snapshot,libraryModifiedAt:libraryStat.mtime.toISOString(),totalTracks:state.tracks.length,ownTracks:own.length,sampleCount:sample.length,order:'First own inLibrary VK tracks in persisted native order; no addedAt sorting',settings,profileReadOnly:true,scope:live?'Metadata+publicsequentialSoundCloudsearch;noaudio':'Metadataonly;noaudio',limits:['Persisted library may lag active in-memory library; record modification timestamp is explicit','Artist card absence is only routing evidence, not proof an upload','Metadata agreement is not fingerprint identity or playback verification','No VK provider network/credentials/cookies, no profiles changed','No stream grants or audio fetched; this does not prove any track starts/finishes','Early baseline rows without sourceHashes retained only the top6 candidates; reranking them is explicitly incomplete'],network:resume?previous.network:{requests:0,statusCounts:{},responseBytes:0},rows:metadataRows};
let nextAt=0,runRequests=0,interrupted=false;
process.on('SIGINT',()=>{interrupted=true;});
function updateSummary(){report.updatedAt=new Date().toISOString();report.priorUnhashedSearches=metadataRows.filter(row=>row.search&&!row.search.sourceHashes).length;report.summary={metadata:{card:count(metadataRows.map(row=>row.artistCard)),scPriority:metadataRows.filter(row=>row.scPriority).length,vkPriority:metadataRows.filter(row=>!row.scPriority).length,withSavedBinding:metadataRows.filter(row=>row.savedBinding).length,retainedOriginalRegistryEntry:metadataRows.filter(row=>row.retainedOriginalRegistryEntry).length,flags:count(metadataRows.flatMap(row=>row.flags))},search:count(metadataRows.filter(row=>row.search).map(row=>row.search.status)),completedSearch:metadataRows.filter(row=>row.search?.completed).length,completeCandidateRows:metadataRows.filter(row=>row.search?.retainedAllCandidates===true).length,incompleteCandidateRows:metadataRows.filter(row=>row.search?.completed&&row.search.retainedAllCandidates!==true).length};}
async function save(){updateSummary();await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');}
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function candidate(value){
  const id=String(value.urn||value.id||'').split(':').at(-1),clean=(text,max)=>[...String(text||'')].filter(letter=>!/[\x00-\x1f\x7f]/u.test(letter)).slice(0,max).join('').trim();
  return {id,title:clean(value.title||'SoundCloud track',300),artist:clean(value.metadata_artist?.trim()?value.metadata_artist:value.publisher_metadata?.artist?.trim()?value.publisher_metadata.artist:value.user?.username||'SoundCloud',200),duration:Number(value.duration)/1000,isrc:value.isrc||value.publisher_metadata?.isrc_code,explicit:value.explicit??value.publisher_metadata?.explicit,streamable:value.access==='playable'&&value.streamable!==false};
}
async function request(query){
  for(let attempt=0;attempt<4;attempt++){
    if(interrupted||runRequests>=maxRequests)throw Error('audit-budget-stop');
    await sleep(Math.max(0,nextAt-Date.now()));nextAt=Date.now()+minInterval;
    const url=new URL('/v1/soundcloud/tracks',origin);url.search=new URLSearchParams({q:query,limit:'30',linked_partitioning:'true',access:'playable'});
    runRequests++;report.network.requests++;const started=Date.now();
    let response;
    try{response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'PulseIndependentMetadataQA/1.0'},signal:AbortSignal.timeout(15000)});}catch(error){if(attempt<2){await sleep(2000*(attempt+1));continue;}throw Error(error.name==='TimeoutError'?'search-timeout':'network-failure');}
    report.network.statusCounts[response.status]=(report.network.statusCounts[response.status]||0)+1;
    if(response.status===429||response.status===503){await response.body?.cancel();const retry=Math.max(2000,Math.min(65000,(Number(response.headers.get('retry-after'))||2**attempt*4)*1000));console.log(JSON.stringify({backoffStatus:response.status,retryMs:retry,requests:runRequests}));await save();await sleep(retry);continue;}
    if(!response.ok){await response.body?.cancel();throw Error('http-'+response.status);}
    const length=Number(response.headers.get('content-length')||0);if(length>2*1024*1024){await response.body?.cancel();throw Error('metadata-size-limit');}
    const bytes=new Uint8Array(await response.arrayBuffer());report.network.responseBytes+=bytes.byteLength;if(bytes.byteLength>2*1024*1024)throw Error('metadata-size-limit');
    const body=JSON.parse(new TextDecoder().decode(bytes));return{collection:(Array.isArray(body)?body:body.collection||[]).map(candidate),hasMore:Boolean(body.next_href),elapsedMs:Date.now()-started};
  }
  throw Error('search-rate-limit-retries-exhausted');
}
await save();console.log(JSON.stringify({phase:'metadata',...report.summary.metadata,snapshotDate:report.libraryModifiedAt,own:own.length,audited:sample.length}));
if(live){
  const priority=metadataRows.filter(row=>refreshIds.has(row.id)||row.scPriority&&!row.search?.completed&&!row.savedBinding).sort((a,b)=>Number(/все сложно|МальчикТемныйНачальник/iu.test(b.title))-Number(/все сложно|МальчикТемныйНачальник/iu.test(a.title))||a.index-b.index);
  for(const row of priority){
    const priorSearch=row.search;
    const priorHistory=priorSearch?.previousSearches||[];
    const {previousSearches:ignoredHistory,...priorWithoutHistory}=priorSearch||{};
    const history=refreshIds.has(row.id)?[...priorHistory,priorWithoutHistory]:priorHistory;
    const track=sample[row.index-1],candidates=[],queries=[...new Set([`${track.artist} ${track.title} ${track.version||''}`,`${normalizeRecordingText(track.title)} ${normalizeRecordingText(track.artist)} ${track.version||''}`,`${track.title} ${track.version||''}`].map(text=>text.trim().replace(/\s+/gu,' ').slice(0,300)).filter(Boolean))].slice(0,3);
    const searches=[];let ranked,exact=[];
    try{
      for(const query of queries){const page=await request(query);for(const item of page.collection)if(!candidates.some(previous=>previous.id===item.id))candidates.push(item);ranked=rankSoundCloudCandidates(track,candidates,{preferExplicit:settings.preferExplicit});exact=ranked.candidates.filter(item=>item.quality==='exact');searches.push({query,count:page.collection.length,hasMore:page.hasMore,elapsedMs:page.elapsedMs});if(exact.length)break;}
      const plausible=ranked?.candidates.filter(item=>item.quality==='review')||[];
      row.search={completed:true,at:new Date().toISOString(),sourceHashes,previousSearches:history.length?history:undefined,previousFailures:row.search?.previousFailures,status:exact.length===1?'unique-observed-metadata-match':exact.length>1?'multiple-exact-recordings':plausible.length?'review-required':'no-observed-match',queries:searches,candidateCount:candidates.length,retainedAllCandidates:true,candidates:ranked?.candidates.map(item=>({id:item.candidate.id,title:item.candidate.title,artist:item.candidate.artist,duration:item.candidate.duration,version:item.candidate.version,isrc:item.candidate.isrc,explicit:item.candidate.explicit,streamable:item.candidate.streamable,quality:item.quality,reasons:item.reasons,durationDifference:item.durationDifference})),observedOnly:true};
    }catch(error){
      if(refreshIds.has(row.id))row.search={...priorSearch,refreshAttempts:[...(priorSearch?.refreshAttempts||[]),{at:new Date().toISOString(),sourceHashes,status:error.message,queries:searches}]};
      else row.search={completed:error.message!=='audit-budget-stop',at:new Date().toISOString(),status:error.message,queries:searches};
      if(error.message==='audit-budget-stop')break;
    }
    await save();if(report.summary.completedSearch%10===0||/все сложно|МальчикТемныйНачальник/iu.test(row.title))console.log(JSON.stringify({phase:'search',lastIndex:row.index,title:row.title,status:row.search.status,completed:report.summary.completedSearch,requests:runRequests,summary:report.summary.search}));
    if(interrupted)break;
  }
}
const after=await readFile(path.join(profile,'library.json'));report.profileSnapshotChangedDuringAudit=createHash('sha256').update(after).digest('hex')!==snapshot;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({phase:'finished',...report.summary,runRequests,profileSnapshotChanged:report.profileSnapshotChangedDuringAudit,report:reportPath}));
