import {bindTrainingTabs,createTrainingPanel} from './exercise-tabs.js';
import {openTrainingHistory} from './training-history.js';
import {computerCopySettingsHtml} from './computer-history.js';
import {api,esc,START,option} from './api.js';
import {t,ui} from './i18n.js';
import {Board} from './board.js';
import {makeDoc,nodeIndex,serialize} from './chess-document.js';
import {renderAnalysisMovesInto} from './analysis-moves.js';
import {playSound,moveSound} from './sound.js';
import {ComputerClock,newClock,clockSettings,clockText} from './computer-clock.js';
import {ComputerActivity,newComputerActivity} from './computer-activity.js';
import {openTrainingStatistics} from './training-statistics.js';
import {newId} from './identifiers.js';

const endpoint='/api/computer';
const clone=value=>structuredClone(value);
const defaults=()=>({provider:'stockfish',skill:10,level:1500,time_ms:500,side:'white',start:'initial',fen:START,time_control:'unlimited',clock_minutes:10,clock_increment:0});
const reasons={checkmate:'Échec et mat',stalemate:'Pat',insufficient_material:'Matériel insuffisant',fifty_moves:'Règle des 50 coups',threefold_repetition:'Triple répétition',seventyfive_moves:'Règle des 75 coups',fivefold_repetition:'Quintuple répétition',resignation:'Abandon',timeout:'Temps écoulé'};

// Keep the full route to an analysis position for castling and repetition rules,
// without sharing the source document or its saved entry identity.
export function computerOrigin(doc,path=''){
 const nodes=nodeIndex(doc),target=nodes.get(path),root=nodes.get('');
 if(!target||!root)throw new Error(t('La position de départ est introuvable.'));
 const history=[],seen=new Set();let node=target;
 while(node.parent!==null){
  if(seen.has(node.path)||!node.uci)throw new Error(t('L’historique de cette position est incomplet.'));
  seen.add(node.path);history.unshift(node.uci);node=nodes.get(node.parent);
  if(!node)throw new Error(t('L’historique de cette position est incomplet.'));
 }
 // A pedagogical null move belongs to the lesson, not to a legally played game.
 // Start its current diagram independently while leaving the lesson untouched.
 if(history.includes('0000'))return {initial_fen:target.fen,history:[],fen:target.fen};
 return {initial_fen:root.fen,history,fen:target.fen};
}

// An independent snapshot owns this game; the parent journals its history and
// optional library copies without sharing a mutable analysis document.
export class ComputerPlayView {
 constructor(host,{initialSettings=null,onSettingsChange=null,onAnalyse=null,onChange=null,onRender=null,onArchive=null,onHistory=null,onSettings=null,onStatistics=null}={}){
  Object.assign(this,{host,onAnalyse,onChange,onRender,onArchive,onHistory,onSettings,onStatistics});this.onSettingsChange=onSettingsChange;this.config={...defaults(),...(initialSettings||{})};this.origin=null;this.session=null;
  this.board=null;this.opponents=[];this.mode='setup';this.disposed=false;this.sequence=0;this.controller=null;this.busy=false;this.error='';this.displayPath='';this.pendingMove=null;this.clock=null;this.clockTimer=null;this.clockSavedAt=0;this.activity=null;this.activityTimer=null;this.activityBlocked=false;
  this.onHidden=()=>{if(globalThis.document?.hidden){if(this.clock||this.activity)this.pauseGame({explicit:false});}else if(this.activity&&!this.clock&&this.mode==='play'&&!this.finished()&&!this.disposed)this.run(()=>this.resume({explicit:false}));};this.onPageHide=()=>this.pauseGame({explicit:false});
  globalThis.document?.addEventListener?.('visibilitychange',this.onHidden);globalThis.window?.addEventListener?.('pagehide',this.onPageHide);
 }
 ensureIdentity(){if(this.session){this.session.id||=newId();this.session.started_at||=new Date().toISOString();}}
 snapshot(){this.clock?.read();this.activity?.read();this.ensureIdentity();return clone({version:1,mode:this.mode,config:this.config,origin:this.origin,session:this.session,displayPath:this.board?.path??this.displayPath,pendingMove:this.pendingMove});}
 changed(){if(!this.disposed)this.onChange?.(this.snapshot());}
 cancelPending(){this.sequence++;this.controller?.abort();this.controller=null;this.busy=false;}
 dispose(){if(this.disposed)return;this.pauseGame({render:false,explicit:false});this.disposed=true;this.statisticsDialog?.close();this.historyDialog?.close();this.settingsPanel?.close();this.cancelPending();this.stopClockTimer();globalThis.document?.removeEventListener?.('visibilitychange',this.onHidden);globalThis.window?.removeEventListener?.('pagehide',this.onPageHide);this.board?.dispose();this.board=null;this.host.classList.remove('computer-page','computer-game-finished');}
 async request(path,body){
  this.controller?.abort();const controller=this.controller=new AbortController(),sequence=++this.sequence;
  try{const result=await api(endpoint+path,{...(body?{method:'POST',body}:{}),signal:controller.signal});return this.disposed||sequence!==this.sequence?null:result;}
  catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return null;throw error;}
  finally{if(this.controller===controller)this.controller=null;}
 }
 async load(snapshot=null){
  // Navigation can dispose this view while availability is still loading. Its
  // immediately readable snapshot must already own the suspended game.
  if(snapshot?.version===1){
   this.config={...defaults(),...clone(snapshot.config)};this.origin=clone(snapshot.origin);this.session=clone(snapshot.session);
   if(this.session){
    this.session.config={...defaults(),...clone(this.session.config||this.config)};this.ensureIdentity();this.clock=this.session.clock?new ComputerClock(this.session.clock):null;this.activity=this.session.activity?new ComputerActivity(this.session.activity):null;
    // Retained Maia games keep their position, side and strength when the
    // provider is upgraded. Update only our generated opponent PGN label.
    const side=this.session.side==='white'?'Black':'White',config=this.session.config;
    if(config.provider==='maia'&&this.session.headers?.[side]==='Maia '+config.level)this.session.headers[side]=this.engineName(config);
   }
   this.mode=snapshot.mode==='play'&&this.session?'play':'setup';this.displayPath=snapshot.displayPath||'';this.pendingMove=typeof snapshot.pendingMove==='string'?snapshot.pendingMove:null;
  }
  this.host.classList.add('computer-page');this.host.innerHTML=ui('<p class="loading">Chargement…</p>');
  try{
   const data=await this.request('/opponents');if(!data)return;this.opponents=data.engines||[];
   if(this.mode==='play')await this.resume({explicit:false});else this.renderSetup();
  }catch(error){this.failure(error);}
 }
 async resume({explicit=true}={}){
  if(!this.session||this.busy)return;
  this.cancelPending();this.mode='play';this.config=clone(this.session.config||this.config);this.session.config=clone(this.config);this.busy=true;this.error='';this.renderPlay();
  const previous=this.session,result=await this.request('/position',this.stateBody(previous.position));if(!result)return;
  // The intent still belongs to this confirmed position. Keep it durable while
  // validating the position so closing during restoration cannot lose the move.
  this.accept(result,{preserveResult:previous.resigned||!!previous.timeout,displayPath:this.displayPath,preservePending:true});
  if(previous.timeout&&previous.headers.Result==='*'){await this.timeout(previous.timeout);return;}
  if(this.clock&&!this.finished()){
   if(this.clock.state.expired){await this.timeout(this.clock.state.expired);return;}
   if(!explicit||globalThis.document?.hidden){this.clock.pause();this.renderPlay();this.changed();return;}
   this.clock.start(this.session.position.turn);this.startClockTimer();this.renderPlay();this.changed();
  }
  if(!this.clock&&!this.finished()){
   // A user pause survives reload/navigation. Temporary visibility and dialog
   // pauses still resume automatically, unless the user had already paused.
   if(!explicit&&(this.session.paused===true||globalThis.document?.hidden)){this.pauseActivity();this.renderPlay();this.changed();return;}
   if(explicit&&this.session.paused===true){this.session.paused=false;this.renderPlay();this.changed();}
  }
  if(!this.finished())this.startActivity();
  if(this.pendingMove){
   if(this.humanTurn()){await this.humanMove(this.pendingMove);return;}
   this.pendingMove=null;this.changed();
  }
  if(!this.finished())await this.engineReply();
 }
 async launch({doc,path=''}={}){
  const origin=computerOrigin(doc,path);this.pauseGame({render:false,explicit:false});this.busy=true;const generation=this.sequence;await this.archive();if(this.disposed||generation!==this.sequence)return;this.cancelPending();this.pendingMove=null;this.session=null;this.clock=null;this.activity=null;this.origin=origin;this.config={...this.config,start:'analysis',fen:this.origin.fen,side:this.origin.fen.split(' ')[1]==='b'?'black':'white'};this.mode='setup';this.error='';
  if(!this.opponents.length)await this.load();else this.renderSetup();this.changed();
 }
 selectedEngine(){return this.opponents.find(engine=>engine.id===this.config.provider);}
 normalizeSetupStrength(){
  const engine=this.selectedEngine(),maia=this.config.provider==='maia',values=maia?engine?.levels:engine?.skills,key=maia?'level':'skill';
  if(!values?.length||values.includes(this.config[key]))return false;
  const preferred=maia?engine.default_level:engine.default_skill;this.config[key]=values.includes(preferred)?preferred:values[0];return true;
 }
 engineName(config=this.mode==='play'?this.session?.config||this.config:this.config){
  const engine=this.opponents.find(item=>item.id===config.provider),name=engine?.name||(config.provider==='maia'?'Maia 3':'Stockfish');
  if(config.provider==='maia')return name+' · '+config.level;
  return engine?.skills?.length===1?name:name+' · '+t('Niveau {level}',{level:config.skill});
 }
 startState(){return this.config.start==='analysis'&&this.origin?clone(this.origin):{initial_fen:this.config.start==='initial'?START:this.config.fen.trim(),history:[]};}
 stateBody(position=this.session?.position){return {initial_fen:position.initial_fen,history:[...position.history],fen:position.fen};}
 finished(){return !!(this.session?.resigned||this.session?.timeout||this.session?.position.game_over);}
 paused(){return !!(this.clock?this.clock.state.paused:this.session?.paused===true)&&!this.finished();}
 humanTurn(){return !this.finished()&&this.session?.position.turn===this.session?.side;}
 canUndo(){
  if(!this.session)return false;
  const s=this.session,startTurn=(s.start.fen||s.start.initial_fen).split(' ')[1]==='b'?'black':'white';
  return s.position.history.length>s.baseline+(startTurn===s.side?0:1);
 }
 failure(error){if(this.disposed)return;this.busy=false;this.activityBlocked=true;this.pauseActivity();if(this.clock){this.clock.pause();this.stopClockTimer();}this.error=error.message||String(error);this.changed();if(this.mode==='play')this.renderPlay();else this.renderSetup();}
 run(action){void Promise.resolve().then(action).catch(error=>this.failure(error));}
 async archive(){if(this.session){this.ensureIdentity();await this.onArchive?.(this.snapshot());}}
 headingActions(){return '<nav class="tabs training-tabs computer-heading-actions" aria-label="'+esc(t('Jouer contre l’ordinateur'))+'">'+ui('<span class="training-tab" aria-current="page">Jouer</span>')+(this.onHistory?ui('<button class="training-tab" type="button" data-computer-history>Historique</button>'):'')+ui('<button class="training-tab" type="button" data-computer-statistics aria-haspopup="dialog">Statistiques</button>')+(this.onSettings?'<button class="training-tab" type="button" data-computer-settings'+(this.mode==='play'?' disabled':'')+'>'+esc(t('Réglages'))+'</button>':'')+'</nav>';}
 bindHeading(){
  bindTrainingTabs(this.host);
  this.host.querySelector('[data-computer-statistics]')?.addEventListener('click',()=>this.run(()=>this.showStatistics()));
  this.host.querySelector('[data-computer-history]')?.addEventListener('click',()=>{this.pauseGame({explicit:false});this.run(()=>this.showHistory());});
  this.host.querySelector('[data-computer-settings]')?.addEventListener('click',()=>this.run(()=>this.showSetupSettings()));
 }
 async showStatistics(){
  if(this.disposed||this.statisticsOpening||this.statisticsDialog?.open)return;
  this.statisticsOpening=true;this.pauseGame({explicit:false});
  try{
   const dialog=await (this.onStatistics?this.onStatistics():openTrainingStatistics({tool:'computer'}));
   if(!dialog)return;if(this.disposed){dialog.close();return;}this.statisticsDialog=dialog;
   await new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
   if(!this.disposed&&!this.clock&&this.mode==='play'&&!this.paused()){this.startActivity();await this.engineReply();}
  }finally{this.statisticsOpening=false;this.statisticsDialog=null;}
 }
 // Only new sessions own this counter; older games remain unmeasured.
 startActivity(){
  if(!this.activity||this.disposed||this.mode!=='play'||this.finished()||this.paused())return;
  const tick=()=>{
   if(this.disposed||!this.activity)return;
   const active=this.mode==='play'&&!this.finished()&&!this.paused()&&!this.activityBlocked&&!globalThis.document?.hidden&&!globalThis.document?.querySelector?.('dialog[open]');
   const before=this.activity.state.elapsed_ms;if(active)this.activity.start();else this.activity.pause();this.activity.read();
   if(this.activity.state.elapsed_ms!==before&&this.clockTimer===null)this.changed();
  };
  tick();if(this.activityTimer===null){this.activityTimer=setInterval(tick,5000);this.activityTimer.unref?.();}
 }
 pauseActivity(){this.activity?.pause();if(this.activityTimer!==null)clearInterval(this.activityTimer);this.activityTimer=null;}
 stopClockTimer(){if(this.clockTimer!==null)clearInterval(this.clockTimer);this.clockTimer=null;}
 startClockTimer(){
  this.stopClockTimer();if(!this.clock||this.clock.state.paused||this.finished())return;
  this.clockSavedAt=performance.now();this.clockTimer=setInterval(()=>{
   if(this.disposed)return;const state=this.clock.read();this.renderClockValues();
   if(state.expired){this.run(()=>this.timeout(state.expired));return;}
   if(performance.now()-this.clockSavedAt>=1000){this.clockSavedAt=performance.now();this.changed();}
  },100);this.clockTimer.unref?.();
 }
 pauseGame({render=true,explicit=true}={}){
  if(!this.session)return;this.pauseActivity();const expired=this.clock?.pause();this.stopClockTimer();this.cancelPending();
  if(explicit&&!this.clock&&!this.finished())this.session.paused=true;
  if(expired&&!this.finished()){this.session.timeout=expired;this.session.finished_at||=new Date().toISOString();}
  if(render&&this.mode==='play'&&!this.disposed)this.renderPlay();this.changed();
  if(expired&&render&&!this.disposed&&this.session.timeout&&this.session.headers.Result==='*')this.run(()=>this.timeout(expired));
 }
 clocksHtml(){
  if(!this.clock)return '';const state=this.clock.read(),s=this.session;
  const sides=s.side==='black'?['black','white']:['white','black'];
  return '<div class="computer-clocks">'+sides.map(side=>'<div class="computer-clock" data-clock="'+side+'"><small>'+t(side==='white'?'Blancs':'Noirs')+'</small><strong data-clock-value="'+side+'">'+clockText(state.remaining[side])+'</strong></div>').join('')+'</div><div class="computer-clock-controls"><span>'+esc(this.finished()?t('Temps final'):state.paused?t('Pendules en pause'):t('Partie chronométrée'))+'</span>'+(!this.finished()?'<button type="button" data-clock-toggle>'+t(state.paused?'Reprendre':'Pause')+'</button>':'')+'</div>';
 }
 renderClockValues(){
  if(!this.clock)return;const state=this.clock.state;
  for(const side of ['white','black']){
   const value=this.host.querySelector?.('[data-clock-value="'+side+'"]'),card=this.host.querySelector?.('[data-clock="'+side+'"]');
   if(value)value.textContent=clockText(state.remaining[side]);
   card?.classList.toggle('active',!state.paused&&state.running===side&&!this.finished());
   card?.classList.toggle('low',state.remaining[side]<=10000);card?.classList.toggle('flagged',state.expired===side);
  }
 }
 async timeout(loser){
  if(this.disposed||!this.session||this.session.resigned||this.session.position.game_over)return;
  this.pauseActivity();this.clock?.pause();this.stopClockTimer();this.cancelPending();this.pendingMove=null;this.session.timeout=loser;this.changed();this.busy=true;this.renderPlay();
  try{const position=await this.request('/timeout',{...this.stateBody(),loser});if(!position)return;this.accept(position,{preserveResult:true});this.session.headers.Result=position.result;this.session.headers.Termination='time forfeit';this.renderPlay();this.changed();}
  catch(error){this.failure(error);}
 }
 renderSetup(){
  if(this.disposed)return;this.board?.dispose();this.board=null;this.host.classList.add('computer-page');this.host.classList.remove('computer-game-finished');
  if(this.normalizeSetupStrength())this.changed();
  this.settingsPanel=null;
  const c=this.config,selected=this.selectedEngine(),available=this.opponents.some(engine=>engine.available);
  this.host.innerHTML=ui('<header class="computer-heading training-header"><h1>Jouer contre l’ordinateur</h1>')+this.headingActions()+ui('</header><div class="computer-workspace computer-setup"><div class="computer-board-column"><div data-board></div></div><section class="panel computer-controls"><form data-setup><div class="computer-config-grid"><label>Adversaire<select name="provider">')+
   this.opponents.map(engine=>option(engine.id,engine.name+(engine.available?'':' · '+t('Indisponible')),c.provider)).join('')+'</select></label><label data-strength-label>'+t(c.provider==='maia'?'Niveau humain (repère Lichess)':'Force')+ui('<select name="strength">')+
   (c.provider==='maia'?(selected?.levels||Array.from({length:21},(_,index)=>600+index*100)).map(level=>option(level,t('Niveau {level}',{level}),c.level)):(selected?.skills||Array.from({length:21},(_,index)=>index)).map(level=>option(level,t('Niveau {level}',{level}),c.skill))).join('')+
   ui('</select></label><label>Ton camp<select name="side">')+[['white',t('Blancs')],['black',t('Noirs')],['random',t('Au hasard')]].map(([value,label])=>option(value,label,c.side)).join('')+ui('</select></label>')+
   (c.provider==='stockfish'?ui('<label data-computer-advanced>Temps par coup<select name="time_ms">')+[[100,'0,1 s'],[250,'0,25 s'],[500,'0,5 s'],[1000,'1 s'],[2000,'2 s']].map(([value,label])=>option(value,label,c.time_ms)).join('')+'</select></label>':'')+
   ui('<label>Cadence<select name="time_control">')+[['unlimited',t('Sans limite')],['3+0','3 min'],['5+0','5 min'],['10+0','10 min'],['15+10','15 min + 10 s'],['30+0','30 min'],['custom',t('Personnalisée')]].map(([value,label])=>option(value,label,c.time_control)).join('')+'</select></label>'+(c.time_control==='custom'?ui('<label data-computer-advanced>Minutes par joueur<input type="number" name="clock_minutes" min="0.1" max="180" step="0.1" required value="')+esc(c.clock_minutes)+ui('"></label><label data-computer-advanced>Incrément (secondes)<input type="number" name="clock_increment" min="0" max="180" step="1" required value="')+esc(c.clock_increment)+'"></label>':'')+ui('<label data-computer-advanced class="computer-wide">Départ<select name="start">')+option('initial',t('Position initiale'),c.start)+(this.origin?option('analysis',t('Position de l’analyse'),c.start):'')+option('fen',t('Position FEN'),c.start)+ui('</select></label>')+
   (c.start==='fen'?ui('<label data-computer-advanced class="computer-wide">Position FEN<textarea name="fen" rows="3" spellcheck="false" required>')+esc(c.fen)+'</textarea></label>':'')+
   '</div><p class="exercise-config-summary">'+esc(t(c.start==='fen'?'Position FEN':c.start==='analysis'?'Position de l’analyse':'Position initiale')+(c.time_control==='custom'?' · '+c.clock_minutes+' min + '+c.clock_increment+' s':''))+'</p>'+(c.provider==='maia'?ui('<p class="hint computer-engine-note">Maia 3 reproduit les habitudes de joueurs humains. Son niveau est indicatif, sans équivalence directe avec ton classement.</p>'):'<p class="hint computer-engine-note">'+t(selected?.skills?.length===1?'La force maximale est utilisée pour ce moteur.':'Les niveaux de force sont propres au moteur et ne correspondent pas à un classement Elo.')+'</p>')+
   (!selected?.available?'<p class="computer-error" role="status">'+esc(selected?.message||t('Ce moteur n’est pas disponible.'))+'</p>':'')+
   (this.error?'<p class="computer-error" role="alert">'+esc(this.error)+'</p>':'')+
   ui('<div class="computer-actions"><button class="primary" type="submit"')+(!available||!selected?.available||this.busy?' disabled':'')+'>'+t(this.busy?'Préparation…':'Jouer')+'</button>'+(this.session?ui('<button type="button" data-resume-game')+(this.busy?' disabled':'')+'>'+t('Reprendre la partie')+'</button>':'')+'</div></form></section></div>';
  const form=this.host.querySelector('[data-setup]');
  for(const field of form.querySelectorAll('select,textarea,input'))field.disabled=this.busy;
  form.onchange=event=>{
   const field=event.target;if(!field.name)return;if(field.name==='time_control'&&field.value==='custom'&&!this.editingSetup){this.run(()=>this.showSetupSettings({time_control:'custom'}));return;}if(['auto_copy','base_id'].includes(field.name)){this.copyPreferences={...this.copyPreferences,auto_copy:form.elements.auto_copy.checked,base_id:Number(form.elements.base_id.value)||null};return;}
   // Blurring the FEN field may be the pointer-down of the Play button. Replacing
   // that button here would swallow the click; input already updates the snapshot.
   if(['fen','clock_minutes','clock_increment'].includes(field.name))return;
   if(field.name==='strength')this.config[this.config.provider==='maia'?'level':'skill']=Number(field.value);
   else this.config[field.name]=['time_ms','clock_minutes','clock_increment'].includes(field.name)?Number(field.value):field.value;
   this.error='';if(!this.editingSetup)this.onSettingsChange?.(clone(this.config));this.changed();this.renderSetup();
  };
  form.querySelector('[name="fen"]')?.addEventListener('input',event=>{this.config.fen=event.target.value;this.changed();});
  for(const field of form.querySelectorAll('[name="clock_minutes"],[name="clock_increment"]'))field.addEventListener('input',event=>{this.config[field.name]=Number(event.target.value);this.changed();});
  form.onsubmit=event=>{event.preventDefault();if(this.editingSetup){this.run(()=>this.saveSetupSettings(form));return;}this.run(()=>this.start());};
  form.querySelector('[data-resume-game]')?.addEventListener('click',()=>this.run(()=>this.resume()));
  const fen=c.start==='analysis'?this.origin?.fen:c.start==='fen'?c.fen:START;
  // An unvalidated FEN is text until Start validates it; preview never crashes the view.
  const preview=/^[prnbqkPRNBQK1-8/]+\s+[wb]\s/.test(fen||'')?fen:START;
  this.board=new Board(this.host.querySelector('[data-board]'),{doc:makeDoc(preview),training:true,flipped:c.side==='black',onMove:()=>{},legalState:{fen:preview,moves:[],game_over:false,result:'*'}});
  this.board.inputLocked=true;this.board.renderBoard();this.bindHeading();this.onRender?.();
  if(this.editingSetup)this.renderSetupSettings();
 }
 async showHistory(){
  if(this.disposed)return;this.pauseGame({explicit:false});this.historyDialog?.close();
  this.historyDialog=await openTrainingHistory({host:this.host,tool:'computer',onOpen:record=>this.onHistory?.(record)});
 }
 async showSetupSettings(patch=null){
  if(this.disposed||this.mode==='play')return;
  const sequence=this.sequence;
  const [settings,library]=await Promise.all([api('/api/computer/settings'),api('/api/library')]);
  if(this.disposed||sequence!==this.sequence)return;
  this.setupBeforeEdit=clone(this.config);if(patch)Object.assign(this.config,patch);this.copyPreferences=settings;this.copyBases=library.bases.filter(base=>!base.reference);this.editingSetup=true;this.renderSetup();
 }
 renderSetupSettings(){
  const form=this.host.querySelector('[data-setup]');if(!form)return;
  const panel=this.settingsPanel=createTrainingPanel(this.host,'settings');panel.className='training-settings-dialog';
  const controls=form.closest('.computer-controls');panel.append(controls);controls.classList.add('computer-settings-controls');
  let copy=form.querySelector('[data-computer-copy-preferences]');
  if(!copy){copy=document.createElement('section');copy.dataset.computerCopyPreferences='';copy.innerHTML='<h2>'+esc(t('Gestion'))+'</h2>'+computerCopySettingsHtml(this.copyPreferences||{},this.copyBases||[]);form.querySelector('.computer-actions').before(copy);}
  const enabled=form.elements.auto_copy,base=form.elements.base_id;
  if(enabled&&base)enabled.onchange=()=>{base.disabled=!enabled.checked;base.required=enabled.checked;};
  // Defaults are edited independently of a retained, paused game.
  form.oninput=()=>{if(enabled)this.copyPreferences={...this.copyPreferences,auto_copy:enabled.checked,base_id:Number(base?.value)||null};};
  const submit=form.querySelector('[type=submit]');submit.textContent=t('Enregistrer les réglages');submit.disabled=false;
  const resume=form.querySelector('[data-resume-game]');if(resume)resume.hidden=true;
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent=t('Annuler');cancel.onclick=()=>{this.config=clone(this.setupBeforeEdit||this.config);this.editingSetup=false;this.renderSetup();};form.querySelector('.computer-actions').append(cancel);
  panel.addEventListener('close',()=>{if(this.settingsPanel===panel&&!this.disposed){this.config=clone(this.setupBeforeEdit||this.config);this.editingSetup=false;this.renderSetup();}},{once:true});
 }
 async saveSetupSettings(form){
  if(!form.reportValidity())return;
  const enabled=form.elements.auto_copy,base=form.elements.base_id;
  if(enabled)await api('/api/computer/settings',{method:'PATCH',body:{auto_copy:enabled.checked,base_id:enabled.checked?Number(base.value):null,expected_revision:this.copyPreferences?.revision}});
  this.onSettingsChange?.(clone(this.config));this.editingSetup=false;this.renderSetup();
 }
 async start(){
  if(this.busy||!this.selectedEngine()?.available)return;
  try{clockSettings(this.config);}catch{this.error=t('Choisis une durée de 0,1 à 180 minutes et un incrément de 0 à 180 secondes.');this.renderSetup();return;}
  this.pauseGame({render:false,explicit:false});this.cancelPending();this.busy=true;this.error='';this.renderSetup();
  try{
   const origin=this.startState(),position=await this.request('/position',origin);if(!position)return;
   const generation=this.sequence;await this.archive();if(this.disposed||generation!==this.sequence)return;
   const side=this.config.side==='random'?(Math.random()<.5?'white':'black'):this.config.side;
   this.session={...(this.trainingRun?{training_run_id:this.trainingRun.id}:{}),started_at:new Date().toISOString(),activity:newComputerActivity(),clock:newClock(this.config,position.history.length),position,side,baseline:position.history.length,start:clone(origin),config:clone(this.config),resigned:false,headers:{Event:t('Partie contre l’ordinateur'),White:side==='white'?t('Joueur'):this.engineName(this.config),Black:side==='black'?t('Joueur'):this.engineName(this.config),Date:new Date().toISOString().slice(0,10).replaceAll('-','.'),Result:position.result||'*'}};
   this.ensureIdentity();this.activity=new ComputerActivity(this.session.activity);this.clock=this.session.clock?new ComputerClock(this.session.clock):null;if(this.clock&&!position.game_over&&!globalThis.document?.hidden)this.clock.start(position.turn);
   if(this.session.clock)this.session.headers.TimeControl=(this.session.clock.initial_ms/1000)+'+'+(this.session.clock.increment_ms/1000);
   this.mode='play';this.displayPath=position.path;this.busy=false;this.accept(position);this.startActivity();this.startClockTimer();await this.engineReply();
  }catch(error){this.failure(error);}
 }
 gameDoc(){const doc=clone(this.session.position.doc);doc.headers={...doc.headers,...this.session.headers};delete doc.id;delete doc.base_id;
  const clocks=new Map((this.session.clock?.history||[]).filter(item=>item.ply>this.session.baseline).map(item=>[item.ply,item.remaining]));
  let ply=0;const nodes=nodeIndex(doc);let node=nodes.get('');while(node?.children?.length){const side=node.fen.split(' ')[1]==='w'?'white':'black';node=nodes.get(node.children[0]);ply++;if(node&&clocks.has(ply))node.clock=Math.round(clocks.get(ply)[side]/1000);}
  doc.pgn=serialize(doc);return doc;}
 accept(position,{preserveResult=false,displayPath=position.path,preservePending=false}={}){
  const previous=this.session.position;
  if(this.clock&&position.history.length===previous.history.length+1&&!this.clock.commit(previous.turn,position.history.length,{finished:position.game_over})){this.run(()=>this.timeout(this.clock.state.expired));return false;}
  this.session.position=position;
  if(!preservePending)this.pendingMove=null;
  if(!preserveResult){this.session.resigned=false;delete this.session.timeout;this.session.headers.Result=position.result||'*';delete this.session.headers.Termination;}
  if(this.finished()){this.pauseActivity();this.clock?.pause();this.stopClockTimer();this.session.finished_at||=new Date().toISOString();}else delete this.session.finished_at;
  this.displayPath=displayPath;this.busy=false;this.error='';this.activityBlocked=false;this.renderPlay();this.changed();
  if(position.history.length>previous.history.length&&position.san)playSound(moveSound(position.san));
  if(position.game_over&&!previous.game_over)playSound('complete');return true;
 }
 status(){
  const position=this.session.position;
  if(this.finished()){
   if(this.session.timeout&&this.session.headers.Result==='*')return {label:t('Temps écoulé'),detail:t('Vérification du résultat…'),className:'thinking',symbol:'…'};
   const result=this.session.headers.Result,won=result===(this.session.side==='white'?'1-0':'0-1');
   return {label:result==='1/2-1/2'?t('Partie nulle'):won?t('Victoire !'):t('Défaite'),detail:t(reasons[this.session.resigned?'resignation':this.session.timeout?'timeout':position.reason]||'Partie terminée'),className:result==='1/2-1/2'?'draw':won?'won':'lost',symbol:result==='1/2-1/2'?'½':won?'✓':'×'};
  }
  if(this.paused())return {label:t('Partie en pause'),detail:t(this.clock?'Reprends la partie pour lancer les pendules.':'Reprends la partie pour continuer.'),className:'paused',symbol:'Ⅱ'};
  return {label:this.busy?(this.humanTurn()?t('Validation…'):t('L’ordinateur réfléchit…')):this.humanTurn()?t('À toi de jouer'):t('Au tour de l’ordinateur'),detail:position.check?t('Échec au roi'):'',className:this.busy?'thinking':'',symbol:this.busy?'…':this.session.side==='white'?'♙':'♟'};
 }
 renderPlay(){
  if(this.disposed||!this.session)return;this.board?.dispose();this.board=null;this.host.classList.add('computer-page');
  const s=this.session,status=this.status(),finished=this.finished(),canUndo=this.canUndo();
  this.host.innerHTML='<header class="computer-heading training-header"><h1>'+esc(this.engineName())+'</h1><span class="muted">'+esc(t(s.side==='white'?'Tu joues les Blancs':'Tu joues les Noirs'))+'</span>'+this.headingActions()+'</header>'+ui('<div class="computer-workspace"><div class="computer-board-column"><div data-board></div></div><section class="panel computer-game-panel">')+this.clocksHtml()+ui('<div class="computer-status ') +status.className+'" role="status" aria-live="polite"><span aria-hidden="true">'+status.symbol+'</span><div><strong>'+esc(status.label)+'</strong>'+(status.detail?'<small>'+esc(status.detail)+'</small>':'')+'</div>'+(finished?'<b>'+esc(s.headers.Result)+'</b>':'')+'</div>'+
   (this.error?'<div class="computer-error" role="alert">'+esc(this.error)+(((this.humanTurn()||finished)&&!this.session.timeout)?'':ui('<button data-retry>Réessayer</button>'))+'</div>':'')+
   ui('<div data-moves class="computer-moves"></div><footer class="computer-actions"><button data-undo')+(!canUndo?' disabled':'')+'>'+t('Reprendre le coup')+'</button>'+
   (!finished?ui('<button data-resign>Abandonner</button>'):'')+ui('<button data-restart>Rejouer</button><button data-new>Nouvelle partie</button>')+
   (this.onAnalyse?ui('<button data-analyse>Analyser la partie</button>'):'')+'</footer></section></div>';
  const doc=this.gameDoc(),path=finished&&nodeIndex(doc).has(this.displayPath)?this.displayPath:s.position.path;
  this.board=new Board(this.host.querySelector('[data-board]'),{doc,path,training:!finished,flipped:s.side==='black',onMove:uci=>this.humanMove(uci),onChange:()=>{this.displayPath=this.board.path;this.renderMoves();this.changed();},legalState:path===s.position.path?s.position.legalState:null});
  if(finished)this.board.tryMove=async()=>false;
  this.board.inputLocked=this.busy||this.paused()||(!finished&&!this.humanTurn());this.board.renderBoard();
  this.host.classList.toggle('computer-game-finished',finished);this.renderMoves();
  this.host.querySelector('[data-undo]').onclick=()=>this.run(()=>this.undo());
  this.host.querySelector('[data-resign]')?.addEventListener('click',()=>this.resign());
  this.host.querySelector('[data-restart]').onclick=()=>this.run(()=>this.restart());
  this.host.querySelector('[data-new]').onclick=()=>{this.pauseGame({render:false,explicit:false});this.cancelPending();this.pendingMove=null;this.mode='setup';this.error='';this.renderSetup();this.changed();};
  this.host.querySelector('[data-retry]')?.addEventListener('click',()=>this.run(()=>this.session.timeout?this.timeout(this.session.timeout):this.paused()?this.resume():this.engineReply()));
  this.host.querySelector('[data-analyse]')?.addEventListener('click',()=>this.run(async()=>{this.pauseGame({explicit:false});await this.onAnalyse({doc:this.gameDoc(),path:this.board.path});if(!this.clock&&!this.paused()){this.startActivity();await this.engineReply();}}));
  this.host.querySelector('[data-clock-toggle]')?.addEventListener('click',()=>this.paused()?this.run(()=>this.resume()):this.pauseGame());
  this.bindHeading();this.renderClockValues();this.onRender?.();
 }
 renderMoves(){
  if(!this.board)return;const host=this.host.querySelector('[data-moves]');renderAnalysisMovesInto(host,this.board.doc,this.board.path);
  for(const button of host.querySelectorAll('[data-path]')){button.disabled=!this.finished();button.onclick=()=>this.board.go(button.dataset.path);}
  const pane=host.querySelector('.analysis-moves');if(!this.finished()&&pane)pane.scrollTop=pane.scrollHeight;
 }
 async humanMove(move){
  if(this.busy||this.disposed||this.paused()||!this.humanTurn())return;
  if(this.clock?.hold()){await this.timeout(this.clock.state.expired);return;}
  this.busy=true;this.error='';this.activityBlocked=false;this.startActivity();this.pendingMove=move;this.changed();
  try{const position=await this.request('/position',{...this.stateBody(),move});if(!position)return;if(this.accept(position))await this.engineReply();}
  catch(error){const illegal=error.status===400||error.status===422;if(illegal){this.pendingMove=null;this.changed();}this.failure(error);if(illegal&&!globalThis.document?.hidden){if(this.clock){this.clock.start(this.session.position.turn);this.startClockTimer();}this.activityBlocked=false;this.startActivity();this.renderPlay();this.changed();}}
 }
 async engineReply(){
  if(this.disposed||this.mode!=='play'||this.busy||this.paused()||this.finished()||this.humanTurn())return;
  this.busy=true;this.error='';this.activityBlocked=false;this.startActivity();this.renderPlay();
  const config=this.session.config||this.config;
  try{const position=await this.request('/move',{...this.stateBody(),provider:config.provider,skill:config.skill,level:config.level,time_ms:config.time_ms});if(position)this.accept(position);}
  catch(error){this.failure(error);}
 }
 async undo(){
  if(!this.canUndo())return;
  const wasRunning=!!this.clock&&!this.clock.state.paused;this.pendingMove=null;this.pauseGame({render:false,explicit:false});this.cancelPending();this.changed();this.busy=true;this.error='';this.renderPlay();
  const s=this.session,history=[...s.position.history];
  // Undo the computer reply and the human move together; if it is still thinking,
  // only the just-entered human move is removed. Never cross the launch position.
  history.pop();const rootSide=s.position.initial_fen.split(' ')[1]==='b'?'black':'white';
  const turn=history.length%2?(rootSide==='white'?'black':'white'):rootSide;
  if(turn!==s.side&&history.length>s.baseline)history.pop();
  const position=await this.request('/position',{initial_fen:s.position.initial_fen,history});if(!position)return;
  if(this.clock){this.clock.restore(position.history.length);if(wasRunning&&!globalThis.document?.hidden){this.clock.start(position.turn);this.startClockTimer();}}
  this.accept(position);this.startActivity();await this.engineReply();
 }
 async restart(){
  if(!this.session)return;this.pendingMove=null;this.pauseGame({render:false,explicit:false});this.cancelPending();this.changed();this.busy=true;this.error='';this.renderPlay();
  const position=await this.request('/position',clone(this.session.start));if(!position)return;
  const generation=this.sequence;await this.archive();if(this.disposed||generation!==this.sequence)return;
  this.session={...this.session,id:null,started_at:new Date().toISOString(),activity:newComputerActivity(),position,clock:newClock(this.session.config,position.history.length),paused:false,resigned:false,timeout:null,headers:{...this.session.headers,Result:position.result||'*'}};
  delete this.session.finished_at;delete this.session.headers.Termination;this.ensureIdentity();this.activity=new ComputerActivity(this.session.activity);this.clock=this.session.clock?new ComputerClock(this.session.clock):null;
  if(this.clock&&!position.game_over&&!globalThis.document?.hidden){this.clock.start(position.turn);this.startClockTimer();}
  this.accept(position);this.startActivity();await this.engineReply();
 }
 resign(){
  if(this.finished())return;this.pauseActivity();this.clock?.pause();this.stopClockTimer();this.cancelPending();this.pendingMove=null;this.session.resigned=true;this.session.finished_at=new Date().toISOString();this.session.headers.Termination='normal';this.session.headers.Result=this.session.side==='white'?'0-1':'1-0';this.error='';this.renderPlay();this.changed();
 }
}
