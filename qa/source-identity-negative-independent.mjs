import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Independent identity counterexamples, never network or library mutation.
// The assertions describe recordings which must not be silently substituted.
const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
const {rankSoundCloudCandidates}=await vite.ssrLoadModule('/src/shared/sourceMatching.ts');
await vite.close();
const results=[];
const track=changes=>({id:'vk-test',title:'Song',artist:'Artist',duration:150,...changes});
const candidate=changes=>({id:'123',title:'Song',artist:'Artist',duration:150,streamable:true,...changes});
function notExact(name,wanted,offered){const result=rankSoundCloudCandidates(wanted,[offered],{preferExplicit:true}).candidates[0];try{assert.notEqual(result.quality,'exact','different recording identity was eligible for automatic selection');results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.message,wanted,offered,result:{quality:result.quality,reasons:result.reasons}});}}

notExact('a mono/radio edition label is not a list of producers',track(),candidate({title:'Song (mono, radio)'}));
notExact('chopped and pitched recording descriptors cannot be erased as producer aliases',track(),candidate({title:'Song (chopped, pitched)'}));
notExact('a part-number subtitle is not a producer credit',track(),candidate({title:'Song (Part, II)'}));
notExact('a VIP dub is not the base original recording',track(),candidate({title:'Song (VIP, Dub)'}));
notExact('producer annotation cannot erase an 8D transformed edition',track(),candidate({title:'Song (prod. Alias, 8D)'}));
notExact('producer annotation cannot erase a bass-boosted edition',track(),candidate({title:'Song (p. Alias, bass boosted)'}));
notExact('producer annotation cannot erase a Russian clean-edition descriptor',track({explicit:true}),candidate({title:'Song (prod. Alias, без мата)',explicit:true}));
notExact('an explicit base track cannot match a clean producer-labelled edition',track({explicit:true}),candidate({title:'Song (prod. Alias) (Clean)'}));
notExact('parenthesized editions remain significant after producer annotation',track(),candidate({title:'Song (p. Alias) (Live)'}));
notExact('contradictory producer note version is not discarded',track(),candidate({title:'Song (prod. Alias)',version:'Acoustic'}));
notExact('producer credits cannot erase a conflicting ISRC',track({isrc:'USABC2612345'}),candidate({title:'Song (elyth,doremio)',isrc:'USABC2612346'}));
notExact('a title contributor cannot swap the explicit aggregate artist list',track({title:'Song + Beta',artist:'Alpha'}),candidate({title:'Song',artist:'Alpha, Gamma'}));
notExact('a title contributor cannot hide an explicit live recording',track({title:'Song + Beta',artist:'Alpha'}),candidate({title:'Song (Live)',artist:'Alpha, Beta'}));
notExact('a contributor with clean descriptor cannot change explicit edition',track({title:'Song + Beta',artist:'Alpha',explicit:true}),candidate({title:'Song (Clean)',artist:'Alpha, Beta'}));
notExact('emoji skin modifiers distinguish emoji-only recording titles',track({title:'👍🏻'}),candidate({title:'👍🏿'}));
notExact('emoji joins distinguish family-title sequences',track({title:'👨‍👩‍👧'}),candidate({title:'👨👩👧'}));
notExact('country flag titles cannot collapse into each other',track({title:'🇷🇺'}),candidate({title:'🇬🇧'}));
notExact('emoji modifiers do not become identical blank titles',track({title:'🕊🕊🕊'}),candidate({title:'🕊🕊'}));
notExact('a long-duration producer suffix still cannot auto-select',track(),candidate({title:'Song (elyth,doremio)',duration:180}));
console.log(JSON.stringify({results,passed:results.filter(result=>result.ok).length,failed:results.filter(result=>!result.ok).length,scope:'Actual production matcher; invented adversarial metadata, no provider availability or playback claims.'}));
if(results.some(result=>!result.ok))process.exitCode=1;
