import {api} from './api.js';
import {t} from './i18n.js';
import {newId} from './identifiers.js';

export const NATIVE_TRAINING_ACTIVITIES=Object.freeze(['puzzles','guess','computer','blindfold','coordinates','color']);
export const isNativeTraining=activity=>NATIVE_TRAINING_ACTIVITIES.includes(activity);
const clone=value=>structuredClone(value);
const source=view=>view.storm||view.attempt||view.session;
const ended=(view,activity)=>activity==='computer'?!!view.finished?.():activity==='puzzles'?!source(view)||source(view).status!=='active':!view.session||!!(view.session.finished||view.session.completed);

// Preserve the exact creation receipt across uncertain responses and navigation.
// The native endpoint, rather than a DOM callback, owns the resulting credit.
export function programCreationBody(view,tool,body){
 const run=view.trainingRun;
 if(!run||['completed','cancelled'].includes(run.state))return body;
 const key='training-native-create:'+run.id+':'+tool;
 const signature=JSON.stringify(body),stored=view.trainingStore?.get(key)||view.trainingCreation?.[key];
 if(stored&&stored.signature!==signature)throw new Error(t('Un lancement attend une confirmation. Reprends ce bloc avant de changer ses réglages.'));
 const pending=stored||{signature,body:{...clone(body),training_run_id:run.id,request_id:newId()}};
 view.trainingCreation||={};view.trainingCreation[key]=pending;view.trainingStore?.set(key,pending);
 return clone(pending.body);
}

export async function nativeProgramRequest(view,tool,body,send){
 try{const value=await send(programCreationBody(view,tool,body));acceptedProgramCreation(view,tool);return value;}
 catch(error){if(error.status>=400&&error.status<500)acceptedProgramCreation(view,tool);throw error;}
}

export function acceptedProgramCreation(view,tool){
 if(!view.trainingRun)return;
 const key='training-native-create:'+view.trainingRun.id+':'+tool;
 delete view.trainingCreation?.[key];view.trainingStore?.remove(key);
}

export function nativeProgramContext(view){
 const retained=view?.trainingRun,native=source(view),id=native?.training_run_id||retained?.id;
 const run=retained?.id===id?retained:null;
 if(!id||run&&['completed','cancelled'].includes(run.state))return null;
 // History can display another occurrence in the same view. Never label it as
 // work for the retained programme just because that programme was opened first.
 if(native&&native.training_run_id!==id)return null;
 return {id,activity:run?.activity||view.trainingActivity,title:run?.block?.title||null};
}

export async function settleNativeProgram(view,action){
 if(!view||view.disposed||view.busy)throw new Error(t('Attends la fin de la réponse en cours avant de quitter ce bloc.'));
 const activity=view.trainingRun?.activity||view.trainingActivity;
 if(action==='finish'&&!ended(view,activity))throw new Error(t('Termine l’exercice ou la partie en cours avant de terminer ce bloc. Tu peux revenir au programme et le reprendre plus tard.'));
 if(activity==='computer'){
  view.pauseGame?.();
  await view.archive?.();
 }
}

export function nativeTrainingOptions(run){
 return clone(run?.launch?.options||run?.block?.options||{});
}

export async function launchNativeProgram(view,run,{request=api,store=null,computerSnapshot=null}={}){
 if(!isNativeTraining(run.activity))throw new Error(t('Cet outil ne peut pas être lancé depuis ce bloc.'));
 const currentSource=source(view),currentRun=currentSource?.training_run_id||view.trainingRun?.id;
 if(currentSource&&!ended(view,run.activity)&&currentRun!==run.id)throw new Error(t('Une autre activité est en cours dans cet outil. Reprends-la ou termine-la avant de lancer ce bloc.'));
 view.trainingRun=clone(run);view.trainingStore=store;view.trainingActivity=run.activity;
 const options=nativeTrainingOptions(run),ref=run.native_ref,baseId=Number(run.launch?.base_id)||null;
 if(run.activity==='computer'){
  let snapshot=computerSnapshot;
  if(ref?.id){const saved=await request('/api/computer/games/'+encodeURIComponent(ref.id));if(view.disposed)return false;snapshot=saved.snapshot;}
  if(snapshot?.session&&!snapshot.session.position?.game_over&&!snapshot.session.resigned&&snapshot.session.training_run_id!==run.id)
   throw new Error(t('Une autre partie contre l’ordinateur est en cours. Reprends-la ou termine-la avant de lancer ce bloc.'));
  if(snapshot?.session?.training_run_id===run.id){await view.load(snapshot);return !view.disposed;}
  Object.assign(view.config,options);await view.load();return !view.disposed;
 }
 if(run.activity==='puzzles'){
  Object.assign(view,{mode:options.mode==='storm'?'storm':'classic',rated:options.rated!==false});
  if(options.filters)view.filters={...view.filters,...clone(options.filters)};
  view.selection=options.selection||((options.filters&&Object.keys(options.filters).length)?'custom':'standard');
  await view.load();if(view.disposed)return false;
  if(view.data?.active&&view.data.active.training_run_id!==run.id&&String(view.data.active.id)!==String(ref?.id))throw new Error(t('Un autre puzzle est en cours. Reprends-le ou termine-le avant de lancer ce bloc.'));
  if(ref?.id){
   if(ref.tool==='storm'){const data=await request('/api/puzzles/storm/'+encodeURIComponent(ref.id));if(view.disposed)return false;view.storm=data.storm;view.attempt=data.attempt;view.stormReceived=Date.now();if(data.storm.status==='completed')await view.openStormResults(data.storm.id);else if(data.attempt)view.showAttempt(data.attempt);}
   else{const attempt=await request('/api/puzzles/attempts/'+encodeURIComponent(ref.id));if(view.disposed)return false;view.attempt=attempt;view.showAttempt(attempt);}
  }
  return !view.disposed;
 }
 if(run.activity==='guess'){
  view.programBaseId=baseId;Object.assign(view.settings,options);
  if(ref?.id)await view.openSession(ref.id);else await view.load();
  return !view.disposed;
 }
 if(run.activity==='blindfold'){
  Object.assign(view.config,options);
  if(run.launch?.category_id==='blindfold'&&!baseId&&!ref?.id){
   // Category starts use the standard Lichess bank, regardless of a previous
   // personal-game reconstruction saved in the standalone exercise settings.
   Object.assign(view.config,{mode:'opening',rated:true,whole_game:false});
   delete view.config.entry_id;view.baseId=null;view.programBaseId=null;
  }
  if(baseId){view.baseId=baseId;view.programBaseId=baseId;view.config.mode='reconstruct';view.config.rated=false;}
  await view.load();if(view.disposed)return false;
  if(view.session&&!view.session.finished&&view.session.training_run_id!==run.id)throw new Error(t('Un autre exercice à l’aveugle est en cours. Reprends-le ou termine-le avant de lancer ce bloc.'));
  if(ref?.id)await view.openHistory(ref.id);
  return !view.disposed;
 }
 if(run.activity==='coordinates')Object.assign(view.config,options);
 if(run.activity==='color'&&[30,60].includes(options.duration))view.duration=options.duration;
 await view.load();if(view.disposed)return false;
 if(ref?.id)await view.openTrainingRecord({id:ref.id,tool:run.activity});
 return !view.disposed;
}
