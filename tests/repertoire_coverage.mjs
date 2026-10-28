import assert from 'node:assert/strict';
import {coverageProbability,coverageRequestOptions,coverageResultsHtml,RepertoireCoverage} from '../static/repertoire-coverage.js';

const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const defaults={ratings:[1600,1800],speeds:['rapid'],min_probability:.01,max_ply:20};
const report=(patch={})=>({base_id:7,color:'white',status:'partial',filters:{ratings:[1600,1800],speeds:['rapid']},options:{min_probability:.01,max_ply:20},positions_scanned:8,prepared_count:4,unknown_count:0,truncated:true,gaps:[{key:'rare',kind:'opponent_reply',probability:.01,san:'Nc6',san_line:'1. e4 e5 2. Nf3 Nc6',moves:['e2e4','e7e5','g1f3','b8c6'],path:'0.0.0',entry_id:9,fen:'rare-fen',pgn:'rare-pgn'},{key:'common',kind:'own_reply',probability:.2,san:null,san_line:'1. e4 c5',moves:['e2e4','c7c5'],path:'0',entry_id:9,fen:'common-fen',pgn:'common-pgn'}],...patch});
class Element{constructor(){this.innerHTML='';this.handlers=new Map();this.dataset={};this.disabled=false;this.hidden=false;this.value='';this.checked=false;}addEventListener(type,fn){this.handlers.set(type,fn);}removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);}contains(){return true;}}
function fixture({onExplore=()=>{}}={}){
 const host=new Element(),selectors=new Map(),ratings=[0,1000,1200,1400,1600,1800,2000,2200,2500].map(value=>Object.assign(new Element(),{name:'ratings',value:String(value),checked:[1600,1800].includes(value)})),speeds=['ultraBullet','bullet','blitz','rapid','classical','correspondence'].map(value=>Object.assign(new Element(),{name:'speeds',value,checked:value==='rapid'}));
 for(const selector of ['.rc-settings','[data-coverage-form]','[data-coverage-controls]','[data-coverage-state]','[data-coverage-error]','[data-coverage-results]',...['scan','reset','cancel'].map(action=>'[data-coverage-action="'+action+'"]')])selectors.set(selector,new Element());
 selectors.set('[name="min_probability"]',Object.assign(new Element(),{value:'1'}));selectors.set('[name="max_ply"]',Object.assign(new Element(),{value:'20'}));
 host.querySelector=selector=>selectors.get(selector)||null;
 host.querySelectorAll=selector=>selector==='[name="ratings"]'?ratings:selector==='[name="ratings"]:checked'?ratings.filter(input=>input.checked):selector==='[name="speeds"]'?speeds:selector==='[name="speeds"]:checked'?speeds.filter(input=>input.checked):[];
 const requests=[];globalThis.fetch=(url,options)=>new Promise(resolve=>requests.push({url,options,respond(payload,status=200){resolve({ok:status<400,status,headers:{get:()=> 'application/json'},json:async()=>payload});}}));
 const panel=new RepertoireCoverage(host,{baseId:7,onExplore});
 return {panel,host,selectors,ratings,speeds,requests,change(name='min_probability'){host.handlers.get('change')({target:{name}});},get:selector=>selectors.get(selector)};
}
const tests={
 probability_and_filters_use_fractions_and_validate_bounds(){
  assert.deepEqual(coverageProbability(.01),{percent:'1 %',odds:'1 sur 100'});assert.equal(coverageProbability(.13).odds,'≈ 1 sur 8');assert.equal(coverageProbability(0).percent,'—');assert.equal(coverageProbability(2).percent,'—');assert.equal(coverageProbability(NaN).percent,'—');assert.equal(coverageProbability(.00001).percent,'< 0,01 %');
  assert.deepEqual(coverageRequestOptions({ratings:['1600','1800'],speeds:['rapid'],minProbabilityPercent:'1',maxPly:'20'}),defaults);
  for(const change of [{ratings:[]},{ratings:['999']},{speeds:[]},{speeds:['unknown']},{minProbabilityPercent:0},{minProbabilityPercent:101},{maxPly:0},{maxPly:61},{maxPly:2.5}])assert.throws(()=>coverageRequestOptions({ratings:['1600'],speeds:['rapid'],minProbabilityPercent:1,maxPly:20,...change}));
 },
 results_rank_gaps_escape_notation_and_state_partial_limits(){
  const data=report({unknown_count:2,message:'Réponse <script>interdite</script>',conditional_root:true});data.gaps[0].san_line='<img onerror="bad">';const html=coverageResultsHtml(data);
  assert.ok(html.indexOf('Choisir un coup')<html.indexOf('Préparer une réponse à Nc6'));assert.match(html,/1 sur 100/);assert.match(html,/20 %/);assert.match(html,/Exploration partielle/);assert.match(html,/2 positions sans estimation/);assert.match(html,/diagramme/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);assert.doesNotMatch(html,/<script|<img/);
  const complete=coverageResultsHtml(report({status:'complete',gaps:[],truncated:false}));assert.match(complete,/seuil et la profondeur choisis/);assert.match(complete,/chemins examinés/);assert.doesNotMatch(complete,/100\s*%|couverture complète/i);
 },
 results_distinguish_local_frequency_mixed_roots_and_stale_data(){
  const data=report({mixed_roots:true,conditional_root:true,stale:true,updated_at:'2026-10-21T14:30:00Z'});data.gaps[0].frequency=.4;const html=coverageResultsHtml(data);
  assert.match(html,/40 % des réponses à cette position/);assert.match(html,/1 sur 100/);assert.match(html,/Plusieurs positions de départ/);assert.match(html,/ne s’additionnent pas/);assert.match(html,/Dernier bilan/);assert.match(html,/Bilan à actualiser/);assert.doesNotMatch(html,/Ce répertoire commence sur un diagramme/);
  const missing=coverageResultsHtml(report({gaps:[],truncated:false,unknown_count:2}));assert.match(missing,/Ajuste les filtres ou réessaie plus tard/);assert.doesNotMatch(missing,/Poursuis l’exploration/);
 },
 mount_only_loads_cache_and_restores_saved_filters(){
  const f=fixture();assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/repertoires/7/coverage');assert.equal(f.requests[0].options.method,'GET');assert.equal(f.requests[0].options.body,undefined);assert.match(f.host.innerHTML,/probabilités sont conditionnelles/);
  f.requests[0].respond(report({filters:{ratings:[1200],speeds:['blitz']},options:{min_probability:.005,max_ply:12}}));return f.panel.ready.then(()=>{assert.deepEqual(f.panel.readOptions(),{ratings:[1200],speeds:['blitz'],min_probability:.005,max_ply:12});assert.match(f.get('[data-coverage-results]').innerHTML,/1200–1399/);assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Continuer l’exploration');assert.equal(f.requests.length,1);});
 },
 async user_changes_survive_a_late_cache_response(){
  const f=fixture();f.get('[name="min_probability"]').value='2';f.change();f.requests[0].respond(report({options:{min_probability:.001,max_ply:30}}));await f.panel.ready;
  assert.equal(f.get('[name="min_probability"]').value,'2');assert.equal(f.panel.dirty,true);assert.match(f.get('[data-coverage-state]').innerHTML,/Réglages modifiés/);assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Appliquer et explorer');
 },
 async permanent_limits_require_narrowing_and_do_not_offer_futile_continuation(){
  const f=fixture(),limited=report({needs_narrowing:true,resumable:false,limit_reasons:['position_limit'],gaps:[],message:'Réduis la profondeur ou augmente le seuil de probabilité.'});f.requests[0].respond(limited);await f.panel.ready;
  assert.equal(f.get('.rc-settings').open,true);assert.equal(f.get('[data-coverage-action="scan"]').disabled,true);assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Affiner les réglages');assert.equal(f.get('[data-coverage-action="reset"]').disabled,false);assert.equal(await f.panel.scan(),false);assert.equal(f.requests.length,1);assert.match(f.get('[data-coverage-results]').innerHTML,/Réduis la profondeur/);assert.doesNotMatch(f.get('[data-coverage-results]').innerHTML,/Poursuis l’exploration/);
  f.get('[name="min_probability"]').value='3';f.change();assert.equal(f.get('[data-coverage-action="scan"]').disabled,false);assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Appliquer et explorer');const scan=f.panel.scan();assert.equal(JSON.parse(f.requests[1].options.body).min_probability,.03);f.requests[1].respond(report({needs_narrowing:false,resumable:true,options:{min_probability:.03,max_ply:20}}));await scan;assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Continuer l’exploration');
 },
 async non_resumable_missing_statistics_offer_refresh_instead_of_continuation(){
  const f=fixture();f.requests[0].respond(report({resumable:false,truncated:true,unknown_count:2,gaps:[]}));await f.panel.ready;assert.equal(f.get('[data-coverage-action="scan"]').textContent,'Actualiser le bilan');assert.equal(f.get('[data-coverage-action="scan"]').disabled,false);assert.doesNotMatch(f.get('[data-coverage-results]').innerHTML,/Poursuis l’exploration/);assert.match(f.get('[data-coverage-results]').innerHTML,/réessaie plus tard/);
 },
 async manual_scan_aborts_cache_prevents_duplicate_and_accepts_only_latest_response(){
  const f=fixture();f.get('[name="min_probability"]').value='2';f.change();const scan=f.panel.scan();assert.equal(f.requests.length,2);assert.equal(f.requests[0].options.signal.aborted,true);assert.deepEqual(JSON.parse(f.requests[1].options.body),{...defaults,min_probability:.02});assert.equal(f.get('[data-coverage-controls]').disabled,true);assert.match(f.get('[data-coverage-state]').innerHTML,/<progress/);
  assert.equal(await f.panel.scan(),false);assert.equal(f.requests.length,2);f.requests[1].respond(report({status:'complete',options:{min_probability:.02,max_ply:20}}));assert.equal(await scan,true);f.requests[0].respond(report({positions_scanned:999}));await f.panel.ready;assert.equal(f.panel.data.positions_scanned,8);assert.equal(f.panel.data.status,'complete');assert.equal(f.get('[data-coverage-action="scan"]').disabled,true);assert.equal(f.get('[data-coverage-action="reset"]').hidden,false);assert.equal(f.get('[data-coverage-controls]').disabled,false);
 },
 async cancel_and_dispose_abort_requests_and_ignore_late_results(){
  const f=fixture();f.requests[0].respond(report());await f.panel.ready;const source=f.panel.data,scan=f.panel.scan({reset:true});assert.equal(JSON.parse(f.requests[1].options.body).reset,true);f.panel.cancel();assert.equal(f.requests[1].options.signal.aborted,true);assert.equal(f.get('[data-coverage-controls]').disabled,false);f.requests[1].respond(report({positions_scanned:99}));await scan;assert.equal(f.panel.data,source);
  const next=f.panel.scan(),html=f.get('[data-coverage-results]').innerHTML;f.panel.dispose();assert.equal(f.requests[2].options.signal.aborted,true);assert.equal(f.host.handlers.size,0);f.requests[2].respond(report({gaps:[]}));await next;assert.equal(f.get('[data-coverage-results]').innerHTML,html);assert.equal(await f.panel.scan(),false);
 },
 async invalid_filters_and_network_errors_preserve_results_without_silent_scan(){
  const f=fixture();f.requests[0].respond(report());await f.panel.ready;const source=f.panel.data;f.ratings.forEach(input=>input.checked=false);assert.equal(await f.panel.scan(),false);assert.equal(f.requests.length,1);assert.match(f.get('[data-coverage-error]').innerHTML,/tranche de classement/);f.ratings[4].checked=true;
  const scan=f.panel.scan();f.requests[1].respond({detail:'Erreur <svg>'},503);assert.equal(await scan,false);assert.equal(f.panel.data,source);assert.match(f.get('[data-coverage-error]').innerHTML,/Erreur &lt;svg&gt;/);assert.equal(f.get('[data-coverage-controls]').disabled,false);
 },
 async explorer_receives_ranked_gap_full_line_and_isolated_profile_once(){
  const calls=[];let finish;const f=fixture({onExplore:(gap,context)=>{calls.push({gap,context});return new Promise(resolve=>{finish=resolve;});}});f.requests[0].respond(report());await f.panel.ready;
  const opening=f.panel.explore(0);assert.equal(calls.length,1);assert.equal(calls[0].gap.key,'common');assert.equal(calls[0].gap.pgn,'common-pgn');assert.deepEqual(calls[0].gap.moves,['e2e4','c7c5']);assert.deepEqual(calls[0].context,{baseId:7,color:'white',filters:{ratings:[1600,1800],speeds:['rapid']},conditionalRoot:false});assert.equal(await f.panel.explore(1),false);
  calls[0].gap.moves.push('a2a3');calls[0].context.filters.ratings.push(2500);assert.equal(f.panel.data.gaps[1].moves.length,2);assert.deepEqual(f.panel.data.filters.ratings,[1600,1800]);finish();assert.equal(await opening,true);
 },
 async explorer_failure_keeps_bilan_available_and_disposal_is_safe(){
  const f=fixture({onExplore:async()=>{throw new Error('Position indisponible');}});f.requests[0].respond(report());await f.panel.ready;assert.equal(await f.panel.explore(0),false);assert.equal(f.panel.opening,false);assert.match(f.get('[data-coverage-error]').innerHTML,/Position indisponible/);assert.equal(f.panel.data.gaps.length,2);assert.equal(await f.panel.explore(100),false);f.panel.dispose();assert.equal(await f.panel.explore(0),false);
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],scenario);await tests[scenario]();
