// Read-only projections of the clocks owned by each exercise. These helpers
// never start a timer, write a receipt, or change an exercise's pause rules.
const TITLES={puzzles:'Puzzles',guess:'Deviner le coup',computer:'Partie contre l’ordinateur',blindfold:'À l’aveugle',coordinates:'Coordonnées',color:'Couleur des cases'};
const CLASSES={PuzzleView:'puzzles',GuessMoveView:'guess',ComputerPlayView:'computer',BlindfoldView:'blindfold',CoordinateView:'coordinates',ColorTrainingView:'color'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const milliseconds=value=>finite(value)?Math.max(0,value):null;
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const terminal=run=>['completed','cancelled'].includes(run?.state);
const monotonic=()=>globalThis.performance?.now?.()??0;

function state(identity,values={}){
 return {...identity,active:true,paused:false,canPause:false,waiting:false,elapsedMs:null,measurementMs:null,targetMs:null,remainingMs:null,clockType:'unknown',clockLabel:'Temps enregistré',progress:null,...values};
}

function deadlineState(view,session,nowMs){
 const duration=milliseconds(session.config?.duration*1000),finished=!!session.finished;
 const waiting=session.deadline==null;
 const serverNow=nowMs/1000-(finite(view.offset)?view.offset:0);
 const remaining=waiting?duration:milliseconds((session.deadline-serverNow)*1000);
 const elapsed=duration==null||remaining==null?null:Math.max(0,duration-Math.min(duration,remaining));
 // An abandoned history item may have ended before its deadline; its public
 // response does not expose that finish time. Do not invent a full duration.
 const measured=finished&&session.result?.abandoned?null:elapsed;
 const worked=(session.index||session.score||session.errors||session.result?.answered||0)>0;
 return {active:!finished,waiting,elapsedMs:elapsed,measurementMs:worked?measured:0,targetMs:duration,remainingMs:finished&&!session.result?.abandoned?0:remaining,
  clockType:remaining==null?'unknown':'countdown',clockLabel:'Temps restant',progress:duration>0&&remaining!=null?Math.min(1,elapsed/duration):null};
}

function computerState(view,session,performanceNow){
 const activity=view.activity,recorded=milliseconds(activity?.state?.elapsed_ms??session.activity?.elapsed_ms);
 const activityNow=typeof activity?.now==='function'?activity.now():performanceNow;
 const elapsed=recorded==null?null:Math.min(31*86400000,recorded+(finite(activity?.last)?Math.max(0,activityNow-activity.last):0));
 const clock=view.clock,clockState=clock?.state??session.clock;
 const finished=!!(session.resigned||session.timeout||session.position?.game_over);
 const paused=!finished&&(typeof view.paused==='function'?view.paused():clockState?!!clockState.paused:session.paused===true);
 // The two chess clocks stay beside the board. The global toolbar measures
 // active practice independently of side-to-move and clock increments.
 return {active:!finished,paused,canPause:!finished,elapsedMs:elapsed,measurementMs:elapsed,clockType:elapsed==null?'unknown':'elapsed',clockLabel:'Temps actif'};
}

/**
 * Project the visible native exercise. Finished free exercises return null;
 * a finished exercise still attached to an open programme retains its controls.
 * measurementMs is the cumulative source duration comparable to
 * run.native_progress[].duration_ms, or null when the native API lacks it.
 * elapsedMs can instead describe a phase/clock (e.g. Blindfold preparation).
 * Labels are French translation keys, to translate at the rendering boundary.
 */
export function nativeToolbarState(view,{activity,nowMs,performanceNow=monotonic(),run=view?.trainingRun}={}){
 if(!view||view.disposed)return null;
 activity||=view.trainingActivity||run?.activity||CLASSES[view.constructor?.name];
 if(!TITLES[activity])return null;
 nowMs??=typeof view.now==='function'?view.now():Date.now();
 const source=activity==='puzzles'?(view.storm||view.attempt):view.session;
 if(!source||activity==='computer'&&view.mode!=='play'||activity==='puzzles'&&view.tab&&view.tab!=='play')return null;
 const program=run&&!terminal(run)&&same(source.training_run_id,run.id)?run:null;
 const finished=activity==='computer'?!!(source.resigned||source.timeout||source.position?.game_over):activity==='puzzles'?source.status!=='active':!!(source.finished||source.completed);
 if(finished&&!program)return null;
 const sourceTool=activity==='puzzles'&&view.storm?'storm':activity;
 const identity={id:program?.id||source.id,nativeId:source.id,programId:program?.id||null,sourceTool,activity,title:program?.block?.title||(sourceTool==='storm'?'Puzzle Storm':TITLES[activity])};
 let values;
 if(activity==='color'||activity==='coordinates')values=deadlineState(view,source,nowMs);
 else if(activity==='computer')values=computerState(view,source,performanceNow);
 else if(sourceTool==='storm'){
  const waiting=source.status==='active'&&source.clock_started===false;
  const delta=!finished&&!waiting&&finite(view.stormReceived)?Math.max(0,nowMs-view.stormReceived):0;
  const remaining=finite(source.remaining_ms)?Math.max(0,source.remaining_ms-delta):null;
  // deadline-start includes the accepted bonus/penalty budget. Subtracting the
  // current remaining time recovers the native elapsed clock without treating
  // a +10s bonus as negative work. Statistical credit is a sum of attempts,
  // which is not exposed here and must not be replaced with this wall clock.
  const budget=finite(source.deadline_ms)&&finite(source.started_ms)?Math.max(0,source.deadline_ms-source.started_ms):null;
  values={active:!finished,waiting,remainingMs:remaining,targetMs:budget,elapsedMs:waiting?0:budget!=null&&remaining!=null?Math.max(0,budget-remaining):null,
   measurementMs:waiting?0:null,clockType:remaining==null?'unknown':'countdown',clockLabel:'Temps du défi'};
 }else if(activity==='puzzles'){
  const elapsed=milliseconds(source.elapsed_ms);
  values={active:!finished,elapsedMs:elapsed,measurementMs:elapsed,clockType:elapsed==null?'unknown':'elapsed',clockLabel:'Temps enregistré'};
 }else if(activity==='guess'){
  const rows=Array.isArray(source.attempts)?source.attempts:[];
  const recorded=rows.reduce((sum,item)=>sum+(milliseconds(item.elapsed_ms)||0),0);
  const thinking=!finished&&!source.awaiting_continue&&!source.pending&&!view.busy;
  const elapsed=recorded+(thinking&&finite(view.startedAt)?Math.max(0,nowMs-view.startedAt):0);
  values={active:!finished,elapsedMs:elapsed,measurementMs:elapsed,clockType:'elapsed',clockLabel:'Temps de réflexion'};
 }else if(activity==='blindfold'){
  const result=source.result,preparation=milliseconds(source.preparation_ms);
  const waiting=!source.started&&!finished;
  const elapsed=preparation==null?null:preparation+(waiting&&finite(view.preparationReceivedAt)?Math.max(0,performanceNow-view.preparationReceivedAt):0);
  const total=milliseconds(result?.total_elapsed_ms);
  values={active:!finished,elapsedMs:finished&&total!=null?total:elapsed,measurementMs:finished?total:waiting?elapsed:null,
   clockType:elapsed==null&&total==null?'unknown':'elapsed',clockLabel:finished&&total!=null?'Temps total':'Temps de visualisation'};
 }
 return state(identity,values);
}

/** Apply an explicit session budget to a known cumulative programme duration. */
export function programToolbarState(run,{elapsedMs,quantity=run?.quantity,sessions=run?.sessions,active=true,paused=run?.state==='paused',canPause=false,...details}={}){
 if(!run||terminal(run))return null;
 const goal=run.launch?.free?null:run.launch?.goal,scoped=goal&&['today','week'].includes(goal.scope)&&['minutes','quantity','sessions'].includes(goal.metric)&&finite(goal.remaining)&&goal.remaining>=0;
 const live=finite(elapsedMs),cumulative=milliseconds(live?elapsedMs:scoped?(run.duration_ms??0):run.duration_ms);
 // A chosen remaining goal starts at the accepted run baseline. Subtracting
 // the old cumulative work again would shorten every resumed session.
 const elapsed=scoped?Math.max(0,cumulative-(milliseconds(goal.baseline_duration_ms)||0)):cumulative;
 const quantityGoal=scoped&&goal.metric!=='minutes';
 const completed=quantityGoal?Math.max(0,(milliseconds(goal.metric==='sessions'?sessions:quantity)||0)-(milliseconds(goal.metric==='sessions'?goal.baseline_sessions:goal.baseline_quantity)||0)):null;
 const minutes=run.launch?.free?null:scoped&&goal.metric==='quantity'?null:scoped&&goal.metric==='minutes'?goal.remaining:run.launch?.minutes??run.block?.session_minutes;
 const target=finite(minutes)&&minutes>0?minutes*60000:null,counting=quantityGoal&&goal.metric==='quantity';
 return state({id:run.id,programId:run.id,activity:run.activity,title:run.block?.title||TITLES[run.activity]||'Entraînement'},
  {...details,active,paused,canPause,elapsedMs:elapsed,targetMs:target,remainingMs:target!=null&&elapsed!=null?Math.max(0,target-elapsed):null,
   clockType:counting?'quantity':target!=null&&elapsed!=null?'countdown':elapsed!=null?'elapsed':'unknown',clockLabel:live?(target!=null?'Temps restant':'Temps actif'):'Temps enregistré',
   goalScope:scoped?goal.scope:null,goalMetric:scoped?goal.metric:null,quantityUnit:quantityGoal?(goal.metric==='sessions'?'sessions':goal.unit):null,
   targetQuantity:quantityGoal?goal.remaining:null,completedQuantity:completed,remainingQuantity:quantityGoal?Math.max(0,goal.remaining-completed):null,
   progress:counting?(goal.remaining>0?Math.min(1,completed/goal.remaining):1):target!=null&&elapsed!=null?Math.min(1,elapsed/target):null});
}
