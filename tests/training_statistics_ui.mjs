import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage,t} from '../static/i18n.js';
import {trainingStatisticsHtml,TrainingStatisticsView,openTrainingStatistics} from '../static/training-statistics.js';
import translations from '../static/locales/en-training-statistics.js';

beforeEach(()=>setLanguage('fr'));
const host=()=>({innerHTML:'',querySelector:()=>null});
const fixture=(tool='color')=>({tool,counts:{total:4,completed:2,active:1,interrupted:1},outcomes:{success:1,failure:1,draw:0,mixed:0,unknown:0},duration:{total_ms:null,known_count:0,unknown_count:2},metrics:{score:15,maximum:20,accuracy:75,best_score:9,errors:5,attempts:2,exact_count:1}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('empty records are an empty state rather than invented performance',()=>{
 const data=fixture();data.counts.total=0;const html=trainingStatisticsHtml(data);assert.match(html,/Aucune statistique enregistrée/);assert.doesNotMatch(html,/Précision globale|75|0 %/);
});
test('active records remain distinct and do not invent completed performance',()=>{
 const data=fixture();data.counts.completed=0;const html=trainingStatisticsHtml(data);assert.match(html,/En cours/);assert.match(html,/Termine une séance/);assert.doesNotMatch(html,/75 %|Précision globale/);
});
test('results expose measured duration sample counts and preserve missing versus zero',()=>{
 const data=fixture();let html=trainingStatisticsHtml(data);assert.match(html,/0 séances mesurées · 2 sans durée enregistrée/);assert.match(html,/>—</);assert.match(html,/75 %/);
 data.duration.total_ms=0;data.duration.known_count=2;data.duration.unknown_count=0;html=trainingStatisticsHtml(data);assert.match(html,/>0 s</);
});
test('computer uses game outcomes and guess uses move scores',()=>{
 const computer=trainingStatisticsHtml(fixture('computer'));assert.match(computer,/Victoires/);assert.match(computer,/Nulles/);assert.match(computer,/Défaites/);assert.doesNotMatch(computer,/Précision globale/);
 const guess=trainingStatisticsHtml(fixture('guess'));assert.match(guess,/Coups évalués/);assert.match(guess,/15 \/ 20/);assert.match(guess,/Score moyen par coup/);assert.doesNotMatch(guess,/Meilleur score de séance/);
});
test('blindfold keeps reconstruction metrics separate and omits unavailable metrics',()=>{
 const data=fixture('blindfold');assert.doesNotMatch(trainingStatisticsHtml(data),/Précision moyenne de reconstruction/);data.metrics={...data.metrics,accuracy_count:2,reconstruction_success_count:2,reconstruction_success:1,solve_success_count:2,solve_success:2};const html=trainingStatisticsHtml(data);assert.match(html,/Précision moyenne de reconstruction/);assert.match(html,/1 \/ 2/);assert.match(html,/2 \/ 2/);
});
test('all owned translations are registered',()=>{setLanguage('en');for(const [source,target] of Object.entries(translations))assert.equal(t(source),target);assert.match(trainingStatisticsHtml(fixture()),/Overall accuracy/);});
test('request targets the scoped aggregate and a newer response always wins',async()=>{
 const pending=[],urls=[],signals=[];const view=new TrainingStatisticsView(host(),{tool:'guess',request:(url,options)=>{urls.push(url);signals.push(options.signal);const value=deferred();pending.push(value);return value.promise;}});
 const old=view.load(),fresh=view.load();assert(signals[0].aborted);assert.equal(urls[0],'/api/training/history/statistics?tool=guess');pending[1].resolve(fixture('guess'));await fresh;pending[0].resolve(fixture('computer'));await old;assert.equal(view.data.tool,'guess');
});
test('closing aborts a pending request and ignores its late response',async()=>{
 const previous=globalThis.document,pending=deferred(),content=host();let signal,removed=false;const listeners={};
 const dialog={innerHTML:'',open:false,querySelector:()=>content,querySelectorAll:()=>[],addEventListener:(event,handler)=>listeners[event]=handler,showModal(){this.open=true;},close(){this.open=false;listeners.close?.();},remove(){removed=true;}};
 globalThis.document={createElement:()=>dialog,body:{append(){}},documentElement:{}};
 try{assert.equal(openTrainingStatistics({tool:'color',request:(url,options)=>{signal=options.signal;return pending.promise;}}),dialog);assert(dialog.open);const html=content.innerHTML;dialog.close();assert(signal.aborted);assert(removed);pending.resolve(fixture());await Promise.resolve();await Promise.resolve();assert.equal(content.innerHTML,html);}finally{globalThis.document=previous;}
});
test('network failures are escaped, retryable, and never masquerade as empty history',async()=>{
 let calls=0;const view=new TrainingStatisticsView(host(),{tool:'color',request:async()=>{calls++;if(calls===1)throw new Error('<script>offline</script>');return fixture();}});await view.load();assert.match(view.host.innerHTML,/Statistiques indisponibles/);assert.match(view.host.innerHTML,/data-statistics-retry/);assert.match(view.host.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(view.host.innerHTML,/<script>|Aucune statistique/);await view.load();assert.match(view.host.innerHTML,/Précision globale/);
});
