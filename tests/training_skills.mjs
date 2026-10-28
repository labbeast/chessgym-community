import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(url.endsWith('/static/training-history.js'))return {format:'module',shortCircuit:true,source:'export class TrainingHistoryView{constructor(host,options){}async load(){}dispose(){}};export const openTrainingHistory=async()=>({close(){}});'};
 if(url.endsWith('/static/board.js'))return {format:'module',shortCircuit:true,source:'export class Board {constructor(host,options){this.path=options.path;globalThis.lastBoard=options;}dispose(){}}'};
 if(url.endsWith('/static/sound.js'))return {format:'module',shortCircuit:true,source:'export const playSound=name=>globalThis.sounds.push(name);'};
 if(url.endsWith('/static/api.js'))return {format:'module',shortCircuit:true,source:`export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';export const api=(...args)=>globalThis.testApi(...args);export const fail=error=>globalThis.errors.push(error);export const esc=(value='')=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');export const option=(v,label)=>'<option value="'+v+'">'+label+'</option>';export const time=s=>s+' s';`};
 return next(url,context);
}});
globalThis.sounds=[];globalThis.errors=[];
const {CoordinateView,BlindfoldView,orderedSquares,squareGrid,localSan}=await import('../static/training-skills.js');
const {setLanguage}=await import('../static/i18n.js');
const host={querySelector:()=>null,querySelectorAll:()=>[],innerHTML:''};
const scenario=process.argv[2];
if(scenario==='blindfold_position_description_groups_icons_and_sorted_squares'){
 const view=new BlindfoldView(host);
 const position={white:[{piece:'P',square:'e4'},{piece:'N',square:'g1'},{piece:'P',square:'a2'},{piece:'K',square:'e1'},{piece:'P',square:'c3'},{piece:'N',square:'b1'},{piece:'P',square:'b2'}],black:[{piece:'p',square:'b7'},{piece:'k',square:'e8'},{piece:'p',square:'a7'}],turn:'black',castling:'KQkq',en_passant:'e3'};
 view.session={config:{mode:'positions'},started:false,prompt:{position}};
 const html=view.promptHtml();
 assert.equal((html.match(/class="skill-piece-group"/g)||[]).length,5);
 assert.equal((html.match(/\/wP.svg/g)||[]).length,1);assert.equal((html.match(/\/bP.svg/g)||[]).length,1);
 assert.match(html,/>a2, b2, c3, e4<\/span>/);assert.match(html,/>b1, g1<\/span>/);assert.match(html,/>a7, b7<\/span>/);
 assert.match(html,/alt="pion"/);assert.match(html,/Trait aux noirs/);assert.match(html,/KQkq/);assert.match(html,/e3/);
 setLanguage('en');assert.match(view.promptHtml(),/alt="pawn"/);assert.match(view.promptHtml(),/>White<\/h3>/);setLanguage('fr');
 position.white[0].square='<script>';assert.doesNotMatch(view.promptHtml(),/<script>/);assert.match(view.promptHtml(),/&lt;script&gt;/);
 view.session={...view.session,config:{mode:'reconstruct'},prompt:{initial_position:position,moves:[]}};assert.match(view.promptHtml(),/skill-piece-group/);
}
if(scenario==='blindfold_preparation_clock_resumes_freezes_and_cleans_up'){
 const originalNow=performance.now,originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval;
 let now=1000,next=0;const intervals=new Map(),clock={textContent:''};
 performance.now=()=>now;globalThis.setInterval=callback=>{intervals.set(++next,callback);return next;};globalThis.clearInterval=id=>intervals.delete(id);
 try{
  const view=new BlindfoldView({...host,querySelector:selector=>selector==='[data-preparation-clock]'?clock:null});
  const session={id:'clock',config:{mode:'opening'},started:false,finished:false,preparation_ms:3000,prompt:{moves:[]}};
  view.adoptSession(session);view.render();assert.equal(intervals.size,1);
  now=5000;[...intervals.values()][0]();assert.equal(clock.textContent,'7 s');
  view.render();assert.equal(intervals.size,1);assert.equal(view.preparationElapsed(),7000);
  view.adoptSession({...session,preparation_ms:9000});view.render();assert.equal(view.preparationElapsed(),9000);
  view.adoptSession({...session,started:true,preparation_ms:9500});view.render();assert.equal(intervals.size,0);
  now=20000;assert.equal(view.preparationElapsed(),9500);assert.match(view.sessionHtml(),/data-preparation-clock>9 s/);
  view.adoptSession({...session,finished:true,result:{preparation_ms:9500,elapsed_ms:0,total_elapsed_ms:9500}});view.render();assert.equal(intervals.size,0);
  view.adoptSession(session);view.render();assert.equal(intervals.size,1);view.dispose();assert.equal(intervals.size,0);
 }finally{performance.now=originalNow;globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;}
}
if(scenario==='blindfold_result_includes_visualization_and_total_without_legacy_double_counting'){
 const view=new BlindfoldView(host);view.session={config:{mode:'opening'},started:true,finished:true,result:{preparation_ms:12000,elapsed_ms:8000,total_elapsed_ms:20000}};
 assert.match(view.resultHtml(),/data-preparation-time>12 s/);assert.match(view.resultHtml(),/data-total-time>20 s/);
 setLanguage('en');assert.match(view.resultHtml(),/Visualization time/);assert.match(view.resultHtml(),/Total time/);setLanguage('fr');
 view.session.result={preparation_ms:12000,elapsed_ms:8000};assert.match(view.resultHtml(),/data-total-time>20 s/);
 view.session.started=false;view.session.result={preparation_ms:12000,elapsed_ms:12000};assert.match(view.resultHtml(),/data-total-time>12 s/);
 view.session.result={elapsed_ms:8000};assert.doesNotMatch(view.resultHtml(),/data-preparation-time/);assert.match(view.resultHtml(),/data-total-time>8 s/);
}
if(scenario==='orientation_and_grid_are_consistent'){
 assert.deepEqual(orderedSquares().slice(0,8),['a8','b8','c8','d8','e8','f8','g8','h8']);
 assert.equal(orderedSquares('black')[0],'h1');assert.equal(orderedSquares('black').at(-1),'a8');
 assert.equal(new Set(orderedSquares()).size,64);
 const html=squareGrid();assert.equal((html.match(/data-square=/g)||[]).length,64);assert(html.includes('class="skill-square light" data-square="a8"'));assert(html.includes('class="skill-square dark" data-square="a1"'));
 assert(!html.includes('<img'));assert(!html.includes('skill-rank'));assert(!html.includes('skill-file'));
 const aids=squareGrid({coordinates:true});assert.equal((aids.match(/class="skill-rank"/g)||[]).length,8);assert.equal((aids.match(/class="skill-file"/g)||[]).length,8);
}
if(scenario==='notation_and_reconstruction_are_localized_and_escaped'){
 assert.equal(localSan('Nf3','fr'),'Cf3');assert.equal(localSan('Qh5+','fr'),'Dh5+');assert.equal(localSan('Rxf7','fr'),'Txf7');assert.equal(localSan('O-O','fr'),'O-O');assert.equal(localSan('Nf3','en'),'Nf3');
 const view=new BlindfoldView(host);view.session={config:{mode:'reconstruct'},title:'<script>x</script>',started:false,prompt:{moves:[{number:1,color:'white',san:'<img>'}]}};
 const html=view.sessionHtml();assert(!html.includes('<script>'));assert(!html.includes('<img>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('&lt;img&gt;'));
 setLanguage('en');assert(view.settingsFieldsHtml().includes('Reconstruct a position'));assert(!view.setupHtml().includes('data-custom-set'));assert(view.settingsFieldsHtml().includes('without a board'));setLanguage('fr');
}
if(scenario==='coordinate_clicks_use_server_receipts_and_ignore_late_result'){
 const view=new CoordinateView(host);view.render=()=>{};view.offset=0;
 view.session={id:'session',index:0,score:0,errors:0,deadline:Date.now()/1000+30,target:{square:'a4'},config:{duration:30}};
 let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 globalThis.testApi=async (url,options)=>{calls.push([url,options]);await gate;return {...view.session,index:1,score:1,target:{square:'c6'},server_time:Date.now()/1000};};
 const one=view.answer('a4'),two=view.answer('a4');assert.equal(calls.length,1);release();await one;await two;
 assert.deepEqual(calls[0][1].body,{square:'a4',index:0});assert.equal(view.session.index,1);assert.equal(view.session.target.square,'c6');assert.equal(sounds.at(-1),'correct');
 let finish;globalThis.testApi=()=>new Promise(resolve=>finish=resolve);const old=view.answer('c6');view.dispose();finish({...view.session,score:2,server_time:Date.now()/1000});await old;assert.equal(view.session.score,1);
}
if(scenario==='coordinate_target_is_inside_board_for_all_modes'){
 const view=new CoordinateView(host);view.offset=0;
 for(const mode of ['coordinates','notation','mixed'])for(const orientation of ['white','black']){
  view.session={id:'coords',score:7,deadline:Date.now()/1000+30,config:{mode,orientation,coordinates:true},target:{square:'d4',piece:'N',notation:mode!=='coordinates'}};
  const html=view.sessionHtml(),boardStart=html.indexOf('class="skill-coordinate-board"'),targetStart=html.indexOf('class="skill-coordinate-target"');
  assert.ok(boardStart>=0&&targetStart>boardStart);
  assert.ok(!html.slice(0,boardStart).includes('skill-target'));
  assert.ok(html.includes(`aria-atomic="true">${mode==='coordinates'?'d4':'Cd4'}</strong>`));
  assert.equal((html.match(/class="skill-target"/g)||[]).length,1);
  assert.equal((html.match(/data-square=/g)||[]).length,64);
  assert.equal(html.match(/data-square="([^"]+)"/)[1],orientation==='white'?'a8':'h1');
  assert.ok(html.includes('<span data-score>7</span>'));
  assert.ok(html.includes('data-clock'));
 }
 setLanguage('en');assert.ok(view.sessionHtml().includes('>Nd4</strong>'));setLanguage('fr');
}
if(scenario==='blindfold_empty_board_never_contains_position_and_has_promotion_choice'){
 const view=new BlindfoldView(host);view.session={id:'blind',config:{mode:'endgame',input:'board'},started:true,finished:false,errors:0,played:[]};view.render=()=>{};
 const html=view.solveHtml();assert.equal((html.match(/data-square=/g)||[]).length,64);assert(!html.includes('<img'));assert(!html.includes('legal'));assert(html.includes('name="promotion"'));
 const calls=[];globalThis.testApi=async(url,options)=>{calls.push([url,options]);return {...view.session,answer_index:1,index:2,correct:true,played:[{san:'Bb5',color:'white',number:3},{san:'a6',color:'black',number:3}]};};
 view.square('f1');assert.equal(view.selectedSquare,'f1');view.square('b5');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls[0][1].body.move,'f1b5=q');assert.equal(calls[0][1].body.index,0);assert.equal(view.answerIndex,1);assert.equal(view.session.index,2);
 await view.answer('Fa4');assert.equal(calls[1][1].body.index,1);
}
if(scenario==='reconstruction_submission_uses_only_user_pieces'){
 const view=new BlindfoldView(host);view.session={id:'blind',config:{mode:'reconstruct'},started:true,finished:false};view.render=()=>{};
 view.selectedPiece='K';view.square('g1');view.selectedPiece='k';view.square('g8');view.selectedPiece='';view.square('g1');assert.deepEqual(view.placed,{g8:'k'});
 const calls=[];globalThis.testApi=async(url,options)=>{calls.push([url,options]);if(url.endsWith('/history'))return {history:[]};return {...view.session,finished:true,result:{success:false}};};
 await view.verify();assert.deepEqual(calls[0][1].body,{pieces:{g8:'k'}});assert.equal(calls[0][0],'/api/skills/blindfold/blind/position');
}
if(scenario==='lost_response_recovers_server_indices_without_resubmitting'){
 const coordinate=new CoordinateView(host);coordinate.render=()=>{};coordinate.offset=0;
 coordinate.session={id:'coords',index:0,score:0,deadline:Date.now()/1000+30,config:{duration:30},target:{square:'a4'}};
 const calls=[];
 globalThis.testApi=async(url,options)=>{calls.push([url,options]);if(options?.method==='POST')throw new TypeError('Lost reply');return {...coordinate.session,index:1,score:1,target:{square:'h8'},server_time:Date.now()/1000};};
 await coordinate.answer('a4');assert.equal(calls.length,2);assert.equal(calls[1][0],'/api/skills/coordinates/coords');assert.equal(coordinate.session.index,1);assert.equal(coordinate.session.score,1);
 const blind=new BlindfoldView(host);blind.render=()=>{};blind.session={id:'blind',config:{mode:'opening'},index:0,errors:0,started:true,finished:false};
 globalThis.testApi=async(url,options)=>{if(options?.method==='POST')throw new TypeError('Lost reply');return {...blind.session,index:2,answer_index:1,played:[{san:'Bb5',color:'white',number:3},{san:'a6',color:'black',number:3}]};};
 await blind.answer('Fb5');assert.equal(blind.answerIndex,1);assert.equal(blind.session.index,2);assert.equal(blind.session.played.length,2);
}
if(scenario==='blindfold_search_ignores_late_results_and_supports_clearing'){
 const input={value:'older'},container={...host,querySelector:selector=>selector==='[name=entry_search]'?input:null};
 const view=new BlindfoldView(container);view.baseId=7;view.render=()=>{};
 const pending=[];globalThis.testApi=url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}));
 const older=view.loadEntries();input.value='newer';const newer=view.loadEntries();
 pending[1].resolve({entries:[{id:2,title:'Newer'}],total:1});await newer;
 pending[0].resolve({entries:[{id:1,title:'Older'}],total:1});await older;
 assert.equal(view.entries[0].id,2);assert.equal(view.config.entry_id,2);
 input.value='';const cleared=view.loadEntries();assert(pending[2].url.endsWith('&search='));
 const latest=view.loadEntries();pending[3].resolve({entries:[],total:0});await latest;pending[2].reject(Error('Stale search failure'));await cleared;
 assert.deepEqual(view.entries,[]);assert.equal(view.entrySearch,'');
 const departing=view.loadEntries();view.dispose();pending[4].resolve({entries:[{id:3}],total:1});await departing;assert.deepEqual(view.entries,[]);
}

if(scenario==='blindfold_final_reconstruction_is_on_by_default_and_optional'){
 const view=new BlindfoldView(host);assert.equal(view.config.reconstruct_after,true);assert.equal(view.config.rated,true);assert.doesNotMatch(view.setupHtml(),/name="reconstruct_after"|data-blind-setup/);assert.match(view.settingsFieldsHtml(),/statistique secondaire/);assert.match(view.settingsFieldsHtml(),/name="reconstruct_after" checked/);
 const originalFormData=globalThis.FormData;globalThis.FormData=class{has(key){return key==='rated';}get(){return null;}};
 try{view.captureConfig({elements:{rated:{},reconstruct_after:{}}});assert.equal(view.config.rated,true);assert.equal(view.config.reconstruct_after,false);assert.equal(view.config.hide_prompt,true);}finally{globalThis.FormData=originalFormData;}
 view.config.reconstruct_after=true;
 view.config.rated=false;assert.doesNotMatch(view.setupHtml(),/name="reconstruct_after"/);assert.match(view.settingsFieldsHtml(),/name="reconstruct_after" checked/);assert.match(view.settingsFieldsHtml(),/Reconstituer aussi la position finale/);
 view.config.reconstruct_after=false;assert.doesNotMatch(view.setupHtml(),/name="reconstruct_after" checked/);
 view.config.mode='reconstruct';assert.doesNotMatch(view.setupHtml(),/name="reconstruct_after"/);
 view.session={config:{mode:'reconstruct'},phase:'reconstruct',started:false,prompt:{moves:[{number:1,color:'white',san:'e4'}]}};assert.match(view.sessionHtml(),/1\. e4/);
 setLanguage('en');view.config.mode='positions';assert.match(view.settingsFieldsHtml(),/Also reconstruct the final position/);setLanguage('fr');
 const launch=new BlindfoldView(host,{initialSettings:{entry_id:42,whole_game:true}}),requests=[];launch.render=()=>{};
 globalThis.testApi=async(url,options)=>{requests.push(options.body);return {id:'native',config:{...options.body},started:false,finished:false};};
 for(const mode of ['opening','positions','reconstruct'])await launch.start({mode});
 for(const payload of requests.slice(0,2)){assert.equal(payload.entry_id,undefined);assert.equal(payload.whole_game,undefined);}
 assert.equal(requests[2].entry_id,42);assert.equal(requests[2].whole_game,true);assert.equal(launch.config.entry_id,42);
}
if(scenario==='rated_blindfold_has_two_profiles_progressive_targets_and_legacy_migration'){
 const view=new BlindfoldView(host,{initialSettings:{mode:'endgame'}});
 assert.equal(view.config.mode,'positions');assert.equal(view.config.rated,true);
 view.data.profiles={opening:{rating:2500,rated_count:30,provisional:false,targets:{moves:38,moves_min:36,moves_max:40}},positions:{rating:1500,rated_count:10,provisional:true,targets:{pieces:11,pieces_min:10,pieces_max:12}}};
 assert.match(view.setupHtml(),/1500/);assert.match(view.settingsFieldsHtml(),/Environ 11 pièces/);assert.doesNotMatch(view.setupHtml(),/value="endgame"/);
 assert.equal((view.setupHtml().match(/data-blindfold-profile=/g)||[]).length,2);
 assert.equal((view.setupHtml().match(/data-rated-puzzle=/g)||[]).length,2);assert.match(view.setupHtml(),/data-exercise-customize/);assert.match(view.settingsFieldsHtml(),/Reconstituer une position/);
 assert.match(view.profilesHtml(),/Cote provisoire · 10 exercices classés/);assert.doesNotMatch(view.profilesHtml(),/\/20/);
 view.data.profiles.positions.rated_count=80;assert.match(view.profilesHtml(),/Cote provisoire · 80 exercices classés/);
 setLanguage('en');assert.match(view.profilesHtml(),/Provisional rating · 80 rated exercises/);setLanguage('fr');
 assert.doesNotMatch(view.setupHtml(),/name="rating_min"|name="max_pieces"|name="hide_prompt"/);
 view.config.rated=false;assert.doesNotMatch(view.setupHtml(),/name="max_pieces"/);assert.match(view.settingsFieldsHtml(),/name="max_pieces"/);
 setLanguage('en');assert.match(view.setupHtml(),/Start/);assert.match(view.setupHtml(),/Change settings/);setLanguage('fr');
}
if(scenario==='rating_result_uses_solution_and_shows_secondary_reconstruction'){
 const view=new BlindfoldView(host);view.session={rated:true,config:{mode:'positions'},finished:true,result:{rated:true,success:true,solve_success:true,reconstruction_success:false,accuracy:99,rating_success:true,rating_before:1500,rating_after:1516,rating_delta:16},document:{nodes:[]}};
 assert.match(view.resultHtml(),/1500 → 1516/);assert.match(view.resultHtml(),/Solution sans erreur/);assert.match(view.resultHtml(),/skill-result-banner success/);assert.match(view.resultHtml(),/statistique secondaire/);assert.match(view.resultHtml(),/99 %/);
 setLanguage('en');assert.match(view.resultHtml(),/Blindfold rating/);assert.match(view.resultHtml(),/Error-free solution/);assert.match(view.resultHtml(),/secondary statistic/);setLanguage('fr');
 Object.assign(view.session.result,{revealed:true,reconstruction_skipped:true});assert.match(view.resultHtml(),/Exercice réussi/);assert.match(view.resultHtml(),/Non effectuée/);assert.doesNotMatch(view.resultHtml(),/Solution révélée/);
 Object.assign(view.session.result,{success:false,solve_success:false,rating_success:false,rating_delta:-16,rating_after:1484});assert.match(view.resultHtml(),/Aucun point gagné/);assert.doesNotMatch(view.resultHtml(),/skill-result-banner success/);
}
if(scenario==='rated_blindfold_restores_active_phase_and_server_answer_index'){
 const view=new BlindfoldView(host);view.render=()=>{};
 const active={id:'resume',phase:'reconstruct',config:{mode:'positions',rated:true,input:'text'},started:true,answer_index:3,color:'black'};
 globalThis.testApi=async url=>url.endsWith('/overview')?{profiles:{positions:{rating:1200}},active_session:active}:url.endsWith('/bases')?{bases:[]}:{history:[]};
 await view.load();assert.equal(view.session.id,'resume');assert.equal(view.answerIndex,3);assert.equal(view.orientation,'black');assert.equal(view.config.input,'text');assert.equal(view.data.profiles.positions.rating,1200);assert.deepEqual(view.placed,{});
}
if(scenario==='final_reconstruction_hides_all_prompts_and_starts_with_an_empty_board'){
 const view=new BlindfoldView(host);view.session={id:'b',phase:'solve',config:{mode:'opening'},started:true};view.placed={e1:'K'};view.selectedSquare='e4';
 view.adoptSession({id:'b',phase:'reconstruct',config:{mode:'opening',input:'text'},started:true,finished:false,prompt:{moves:[{number:9,color:'white',san:'RevealedMove'}]},played:[{number:10,color:'black',san:'RevealedReply'}],solve_result:{success:true}});
 assert.deepEqual(view.placed,{});assert.equal(view.selectedSquare,'');const html=view.sessionHtml();assert.match(html,/Étape 2/);assert.match(html,/data-verify/);assert.match(html,/Passer la reconstruction/);assert.match(html,/Statistique secondaire/);assert.doesNotMatch(html,/RevealedMove|RevealedReply|data-blind-answer|data-result-board/);
 assert.equal((html.match(/data-square=/g)||[]).length,64);assert.equal((html.match(/<img/g)||[]).length,12); // Palette only.
 view.placed={g1:'K'};view.adoptSession({...view.session});assert.deepEqual(view.placed,{g1:'K'});
}
if(scenario==='correct_final_move_enters_memory_stage_without_finishing_or_fetching_history'){
 const view=new BlindfoldView(host);view.render=()=>{};view.session={id:'b',phase:'solve',config:{mode:'endgame',reconstruct_after:true},started:true,finished:false};const calls=[];
 globalThis.testApi=async(url,options)=>{calls.push([url,options]);return {...view.session,phase:'reconstruct',finished:false,correct:true,answer_index:1,solve_result:{success:true,errors:0}};};
 await view.answer('Qg7#');assert.equal(view.session.phase,'reconstruct');assert.equal(calls.length,1);assert.equal(sounds.at(-1),'correct');assert(!sounds.includes('complete'));
 view.selectedPiece='K';view.square('f6');assert.deepEqual(view.placed,{f6:'K'});assert.equal(calls.length,1);await view.answer('Kh8');assert.equal(calls.length,1);
 globalThis.testApi=async(url,options)=>{calls.push([url,options]);return url.endsWith('/history')?{history:[]}:{...view.session,phase:'finished',finished:true,result:{success:false,reconstruction_success:false}};};
 await view.verify();assert.equal(calls[1][0],'/api/skills/blindfold/b/position');assert.deepEqual(calls[1][1].body,{pieces:{f6:'K'}});
}
if(scenario==='lost_last_move_response_recovers_reconstruction_without_leaking_position'){
 const view=new BlindfoldView(host);view.render=()=>{};view.session={id:'b',phase:'solve',config:{mode:'endgame'},started:true,finished:false};view.placed={a1:'Q'};let calls=0;
 globalThis.testApi=async(url,options)=>{calls++;if(options?.method==='POST')throw Error('Lost reply');return {...view.session,phase:'reconstruct',answer_index:1,solve_result:{success:true}};};
 await view.answer('Qg7#');assert.equal(calls,2);assert.equal(view.session.phase,'reconstruct');assert.deepEqual(view.placed,{});assert.equal(view.answerIndex,1);assert.match(view.sessionHtml(),/data-verify/);assert.doesNotMatch(view.sessionHtml(),/data-result-board/);
}
if(scenario==='puzzle_result_keeps_reconstruction_as_secondary_statistics'){
 const view=new BlindfoldView(host);view.session={config:{mode:'endgame'},finished:true,result:{success:true,solve_success:true,solve_errors:0,solve_elapsed_ms:5000,reconstruction_success:false,reconstruction_elapsed_ms:9000,elapsed_ms:14000,accuracy:50,correct:['g7'],missing:[{piece:'k',square:'h8'}],misplaced:[{piece:'K',square:'f5'}],proposed:{g7:'Q',f5:'K'}},document:{nodes:[]}};
 const html=view.resultHtml();assert.match(html,/skill-stage-outcomes/);assert.match(html,/Calcul/);assert.match(html,/Position finale · statistique secondaire/);assert.match(html,/Pièces manquantes/);assert.match(html,/Noirs · roi h8/);assert.match(html,/Blancs · roi f5/);assert.match(html,/50 %/);assert.match(html,/skill-result-banner success/);
 setLanguage('en');assert.match(view.resultHtml(),/Calculation/);assert.match(view.resultHtml(),/Expected position/);setLanguage('fr');
 assert.equal(typeof view.showHistory,'function','history uses the common inspector');
}
if(scenario==='completed_two_stage_puzzle_opens_board_at_its_final_position'){
 const container={...host,querySelector:selector=>selector==='[data-result-board]'?{}:null},view=new BlindfoldView(container);view.session={config:{mode:'opening'},finished:true,result:{success:true,solve_success:true,reconstruction_success:true},document:{nodes:[{path:'',san:null},{path:'0',san:'e4'},{path:'0.0',san:'e5'}]}};view.render();assert.equal(globalThis.lastBoard.path,'0.0');
}
assert.deepEqual(errors,[]);console.log('PASS '+scenario);
