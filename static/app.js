import {watchPrivatePairingLinks} from './private-access-messages.js';
// A paired device may reopen its original link; remove the credential immediately.
watchPrivatePairingLinks(globalThis.location,globalThis.history);
import {setListOwner,CollectionList} from './list-view.js';
import {mountCollectionView} from './collection-views.js';
import {exerciseCatalogHtml} from './exercise-catalog.js';
import {t,ui,getLanguage,setLanguage,LANGUAGES} from './i18n.js';
import {desktopNavigationHtml,mobileNavigationHtml,bindMainNavigation,navigationLabel,navigationActivities,updateNavigationActivities} from './main-navigation.js';
import {boardRecentMetadata,boardMenuModel,boardMenuHtml} from './board-menu.js';
import {BoardDraftMenu} from './board-draft-menu.js';
import {BoardRecentPreview} from './board-recent-preview.js';
import {boardRecentPosition} from './board-recent-position.js';
import {draftManagerModel,draftManagerHtml,workspaceConflictHtml} from './draft-manager.js';
import {configureSound,installSoundGestures} from './sound.js';
import {bindSoundSettings} from './sound-settings.js';
import {applyTextSize,bindTextSizeSettings} from './text-size.js';
import {reviewDefaults,bindReviewPreferences} from './review-preferences.js';
import {preferencesService} from './preferences-store.js';
import {startupPreferences,bindStartupSettings} from './startup-settings.js';
import {bindLearningSettings} from './learning-settings.js';
import {bindResourceSettings} from './resource-settings.js';
import {bindEngineManager} from './engine-manager.js';
import {bindSetupResources} from './setup-resources.js';
import {bindAppUpdates} from './app-updates.js';
import {bindPrivateAccess} from './private-access.js';
import {clearAnalysisCache,applyAnalysisEngine} from './engine-analysis.js';
import {globalSettingsHtml,backupSettingsHtml as settingsBackupHtml,languageSettingsHtml} from './settings-page.js';
import {bindSettingsTabs} from './settings-tabs.js';
import {bindBackupSettings} from './backup-settings.js';
import {api,notice,fail,esc,option,field,select,modal,download,START,TYPES,time} from './api.js';
import {Board,makeDoc,serialize,pieces} from './board.js';
import {recordPositionEvaluation,evaluationIndependentContent} from './position-evaluation.js';
import {importedMoveEvaluation} from './move-metrics.js';
import {startReview,reviewSessionFinished,stopReview,suspendReview,snapshotReview,reviewSnapshotData,prepareReviewResume,resumeReview,reviewAssistance,reviewFen,reviewBoard,reviewTrainingContext,settleReviewTraining,reviewToolbarState,pauseReviewToolbar,resumeReviewToolbar} from './review.js';
import {TrainingSessionBar} from './training-session-bar.js';
import {nativeToolbarState,programToolbarState} from './training-toolbar-state.js';
import {TrainingToolbarProgress} from './training-toolbar-progress.js';
import {mutateTrainingRun,prepareTrainingReview,readingLaunchTarget,conflictingReview,scopedReviewSnapshot} from './training-plan-launch.js';
import {isNativeTraining,launchNativeProgram,nativeProgramContext,settleNativeProgram} from './training-native.js';
import {editMetadata} from './metadata.js';
import {EntryTable} from './entry-table.js';
import {ReferenceLibrary,referenceImportDialog,referenceStatusLabel} from './reference-library.js';
import {makeEntryNavigation,entryNavigationState,entryNavigationHtml} from './entry-navigation.js';
import {reviewBasesTableHtml} from './review-bases.js';
import {reviewAllActionsHtml,prepareAllReviews} from './review-all.js';
import {LibraryMenu} from './library-menu.js';
import {libraryModes,libraryModeSettings,libraryModeBadgesHtml} from './library-modes.js';
import {LibraryDrag} from './library-drag.js';
import {baseLogoHtml,baseAppearanceSettingsHtml,BaseAppearanceEditor} from './base-appearance.js';
import {createFolderViewState,libraryFoldersHtml,bindLibraryFolders,isFolderEmpty} from './library-folders.js';
import {ReviewStatistics} from './review-statistics.js';
import {MoveMenu,AnalysisHistory} from './move-menu.js';
import {OpeningExplorer} from './explorer.js';
import {PlayedGamesPanel,GameAnalysisPanel} from './played-games.js';
import {GameReportSession} from './game-report-session.js';
import {GameReportProgressStore} from './game-report-progress.js';
import {RepertoirePanel} from './repertoire-panel.js';
import {validateTranspositionDocument} from './repertoire-transpositions.js';
import {PositionPanel} from './position-panel.js';
import {RepertoireCoverage,coverageProbability} from './repertoire-coverage.js';
import {AnalysisCharts} from './analysis-charts.js';
import {analysisMovesHtml,renderAnalysisMovesInto,followAnalysisMove} from './analysis-moves.js';
import {observeAnalysisLayout} from './analysis-layout.js';
import {mountMobileAnalysis} from './mobile-analysis.js';
import {readingControlsHtml,mountReadingControls} from './reading-controls.js';
import * as displayPreferences from './reading-controls.js';
import {guessBaseSettingsHtml} from './guess-bases.js';
import {ReadingTracker,mainlineNodes,savedReadingNode,readingPercent,readingSettingsHtml,readingDashboardHtml,readingStripHtml,readingBaseSummaryHtml,flushReadingWrites,resetReadingContext} from './reading-progress.js';
import {AnalysisTimeTracker,boardStudyActivity,flushAnalysisWrites,resetAnalysisContext} from './analysis-time.js';
import {openExerciseEditor} from './exercise-editor.js';
import {pieceUrl,applyAppearance,bindAppearanceSettings} from './appearance.js';
import {WorkspaceStore} from './workspace-store.js';
import {COMPUTER_WORKSPACE_KEY,computerSessionSnapshot,persistComputerSession} from './computer-workspace.js';
import {ComputerHistoryStore} from './computer-history-store.js';
import {ComputerHistoryView,openComputerSettings} from './computer-history.js';
import {TrainingHistoryView,openTrainingHistory} from './training-history.js';
import {bindTrainingTabs} from './exercise-tabs.js';
import {openTrainingStatistics} from './training-statistics.js';
import {analysisIdentity,isPristineAnalysis,annotationFor,pruneEmptyAnalyses,draftKeys,analysisSnapshot,persistAnalysisSnapshot} from './workspace-drafts.js';
import {AnnotationDrafts,visibleComment,documentKey} from './annotation-drafts.js';
import {SectionNavigation,routeFromHash} from './section-navigation.js';
import {disposeViews} from './view-lifecycle.js';
const app=document.getElementById('app');
const state={page:'library',library:{folders:[],bases:[]},baseId:null,entryNavigation:null,tab:'content',entries:[],readingBases:[],reviews:[],reviewView:'bases',reviewStatisticsOptions:{baseId:null,days:90,historyMetric:'count'},doc:makeDoc(),path:'',board:null,filter:'',folder:null,analysisTool:'explorer',settings:null,preferences:{theme:'copper',piece_set:'cburnett',board_theme:'brown'}};
const libraryFolderState=createFolderViewState();
const markingEntriesSeen=new Set();
let entryNavigationBusy=false,entryNavigationLoad=null,coveragePanel=null;
setLanguage(getLanguage());
let collectionView=null;
let mainNavigation=null,boardDraftMenu=null,boardRecentPreview=null,trainingView=null,trainingLaunch=null;
let trainingViewPage=null,computerSnapshot=null,computerLaunch=null,activityHistory=null,activityHistoryDialog=null,trainingRecordLaunch=null;
installSoundGestures();
preferencesService.subscribe(prefs=>{configureSound(prefs);applyTextSize(prefs);state.preferences={...state.preferences,...prefs};});
let status;
let positionPanel=null,explorer=null,moveMenu=null,playedGames=null,gameAnalysis=null,repertoirePanel=null,analysisCharts=null,analysisReport=null,analysisResize=null,readingControls=null,editorBusy=false,documentRequest=0;
let analysisWorkspace=null,reviewNavigationReady=false,reportSession=null;
let referenceLibrary=null,readingTracker=null,analysisTimeTracker=null,analysisOnly=false,engineManager=null,setupResources=null,appUpdates=null,privateAccess=null,setupTabRequested=false,engineSettingsRequest=0;
let pausedReview=null,resumingReview=false,entryTable=null,reviewStatistics=null,libraryMenu=null,libraryDrag=null,baseAppearanceEditor=null,mobileAnalysis=null;
let trainingSessionBar=null,reviewLaunching=false;
let toolbarRunCache=null,toolbarRunRequest=null,toolbarRunRefresh=0,toolbarRunSource=null;
const toolbarProgress=new TrainingToolbarProgress();
const freeHistory=new AnalysisHistory(100);freeHistory.reset(state.doc,state.path);
let annotationContext=null,workspaceRestoring=false,boardVisit=null;
let loadedWorkspaceIdentity=null;
const workspaceWarnings=new Map();
const boardMenuMarkup=new WeakMap();
let remoteActivities=[],reviewDueCount=null,activityRequest=null;
const workspace=new WorkspaceStore({request:api,onChange:key=>workspaceChanged(key)});
const computerHistory=new ComputerHistoryStore({request:api,onChange:()=>updateComputerWorkspaceStatus()});
const reportProgress=new GameReportProgressStore({request:api});
const drafts=new AnnotationDrafts(workspace);
const sectionNavigation=new SectionNavigation({onNavigate:restoreRoute,onError:fail});
function currentRoute(){return {page:state.page,baseId:state.baseId,entryId:state.doc.id||null,tab:state.tab,...(state.trainingToolbar?{training:true}:{}),...(state.page==='training-plan'?{view:state.trainingPlanView||'today'}:{})};}

function expectedRevision(doc){const stored=drafts.store.get(drafts.key(doc)),revision=(stored&&Object.keys(stored.nodes||{}).length?stored.revision:null)||doc.revision;return revision?{expected_revision:revision}:{};}
function prepareSavedAnalysis(doc){if(doc.id){doc.analysis_dirty=false;doc.analysis_source_line=mainlineNodes(doc).map(({path,fen})=>({path,fen}));}return doc;}
function savedAnalysisEvaluations(saved,source,board){
 let doc=prepareSavedAnalysis(saved);
 // The request saved a snapshot. Keep any deeper scores received while it was
 // in flight as a recovery draft on top of the returned revision.
 for(const node of source.nodes){
  const value=importedMoveEvaluation(node.comment);
  if(value)doc=recordPositionEvaluation(doc,node.path,node.fen,value);
 }
 const pending=board.deferredEngineResult;
 if(pending&&!pending.evaluationRecorded&&board.engineUpdateIsCurrent?.(pending)){
  doc=recordPositionEvaluation(doc,pending.path??board.path,pending.fen,pending.result.lines?.[0]);
  pending.evaluationRecorded=true;
 }
 return doc;
}
function hasAnalysisDraft(doc=state.doc){return !doc.id||!!doc.analysis_dirty||drafts.has(doc);}
function captureAnnotation(){if(annotationContext){drafts.capture(annotationContext.doc,annotationContext.path,document.getElementById('annotation-form'));}}
function currentAnalysisIsPristine(){return isPristineAnalysis({doc:state.doc,drawings:state.board?.doc===state.doc?state.board.drawings:analysisWorkspace?.doc===state.doc?analysisWorkspace.drawings:[]},annotationFor(workspace,{doc:state.doc}));}
function persistAnalysis(){
 if(reportSession)return;
 if(workspaceRestoring||state.page!=='board'||!state.board||state.board.doc!==state.doc)return;
 if(currentAnalysisIsPristine()){updateWorkspaceStatus();return;}
 documentKey(state.doc);const identity=analysisIdentity(state.doc);if(boardVisit?.identity!==identity)boardVisit={identity,openedAt:new Date().toISOString()};
 const b=state.board,view={...(hasAnalysisDraft()?{draftLabel:workspace.get('view:'+identity)?.draftLabel}:{}),boardRecent:boardRecentMetadata(state.doc,state.entryNavigation,state.library.bases,boardVisit.openedAt),path:b.path,flipped:b.flipped,engineOn:b.engineOn,arrows:b.arrows,drawings:b.drawings||[],studyActivity:analysisOnly?'analysis':null,analysisPaused:!!analysisTimeTracker?.paused,entryNavigation:state.entryNavigation,analysisTool:state.analysisTool,analysisMobilePanel:state.analysisMobilePanel};
 persistAnalysisSnapshot(workspace,state.doc,view,{draft:hasAnalysisDraft()});
 updateWorkspaceStatus();
}
function persistReview(snapshot){if(workspaceRestoring)return;const value=snapshot||snapshotReview();if(value?.base&&value.cards){if(reviewSessionFinished(value))workspace.remove('review');else workspace.set('review',reviewSnapshotData(value));}}
function persistComputer(snapshot){
 const value=snapshot||(trainingViewPage==='computer'?trainingView?.snapshot():computerSnapshot);
 if(!value)return;
 if(computerSessionSnapshot(value)||!computerSnapshot?.session)computerSnapshot=value;
 if(workspaceRestoring||!workspace.ready||loadedWorkspaceIdentity!==JSON.stringify([status?.username,status?.workspace_epoch||'initial']))return;
 persistComputerSession(workspace,value);computerHistory.record(value);
}
function updateComputerWorkspaceStatus(){
 if(trainingViewPage!=='computer')return;
 const heading=document.querySelector('.computer-heading');if(!heading)return;
 const saved=workspace.get(COMPUTER_WORKSPACE_KEY);if(!saved?.session)return;
 let button=heading.querySelector('[data-computer-workspace]');
 if(!button){button=document.createElement('span');button.dataset.computerWorkspace='';button.className='computer-workspace-status';heading.append(button);}
 const info=workspace.info(COMPUTER_WORKSPACE_KEY),archive=computerHistory.info(saved.session.id);
 button.dataset.state=info.conflict?'conflict':info.error?'error':info.dirty?'pending':info.remote?'saved':'local';
 button.textContent=info.conflict?t('Partie · conflit'):info.error?t('Reprise · à vérifier'):info.dirty&&info.remote?t('Partie · synchronisation…'):info.remote?t('Partie conservée'):t('Partie · cet appareil');
 button.title=t('Partie conservée pour la reprise.');
 let conflictButton=heading.querySelector('[data-computer-conflict]');
 if(info.conflict&&!conflictButton){conflictButton=document.createElement('button');conflictButton.type='button';conflictButton.dataset.computerConflict='';conflictButton.textContent=t('Choisir la version à conserver');conflictButton.onclick=()=>showWorkspaceConflicts([COMPUTER_WORKSPACE_KEY]);heading.append(conflictButton);}
 if(!info.conflict)conflictButton?.remove();
 if(archive.error||archive.conflict){button.dataset.state='error';button.textContent=t('Historique · à vérifier');button.title=archive.error||t('Deux versions de cette partie existent.');}
 else if(archive.autoCopyError){button.dataset.state='error';button.textContent=t('Copie à vérifier');button.title=archive.autoCopyError;}
 else if(archive.pending){button.dataset.state='pending';button.textContent=t('Partie · synchronisation…');}
}
function reviewCallbacks(id){return {
 sessionSupport:!!status.capabilities?.review_sessions,sessionContextSupport:!!status.capabilities?.daily_review_sessions,
 receiptSupport:!!status.capabilities?.review_receipts,maintenanceEnabled:!!status.capabilities?.review_maintenance&&state.preferences.review_maintenance?.enabled!==false,
 onClose:()=>{const context=programSessionContext();if(context)return programSessionAction('return',context);pausedReview=null;workspace.remove('review');stopReview();return navigate('reviews');},
 onPause:async()=>{const context=programSessionContext();if(context)return programSessionAction('pause',context);const snapshot=suspendReview({assisted:false});if(!snapshot)return;persistReview(snapshot);pausedReview=null;teardown();state.page='reviews';await refresh();},
 onToolbarResume:()=>{const context=trainingToolbarContext();if(context)return trainingToolbarAction('resume',context);},
 onSettings:card=>{const baseId=card?.base_id??id;if(baseId==null)return;state.tab='settings';return navigate('base',{baseId,keepTab:true});},
 onEditEntry:openReviewEntry,onExploreLine:({doc,path})=>showEngineWorkspace(doc,path),onStateChange:()=>persistReview()
};}
function unfinishedActivities(){
 return navigationActivities({review:workspace.get('review'),computer:workspace.get(COMPUTER_WORKSPACE_KEY),run:workspace.get('training-plan-active')?.run,activities:remoteActivities});
}
function refreshActivityIndicators(){updateNavigationActivities(document.querySelector('.topbar'),unfinishedActivities(),{reviewDueCount});}
async function refreshUnfinishedActivities(){
 refreshActivityIndicators();
 if(!workspace.ready||activityRequest)return;
 const request={identity:loadedWorkspaceIdentity};activityRequest=request;
 try{
  const result=await api('/api/training/unfinished');
  if(request===activityRequest&&request.identity===loadedWorkspaceIdentity){remoteActivities=Array.isArray(result.activities)?result.activities:[];reviewDueCount=Number.isSafeInteger(result.review_due_count)&&result.review_due_count>=0?result.review_due_count:null;refreshActivityIndicators();}
 }catch{/* Workspace indicators remain available when the server is offline. */}
 finally{if(activityRequest===request)activityRequest=null;}
}
function workspaceChanged(key){
 refreshActivityIndicators();updateWorkspaceStatus();updateComputerWorkspaceStatus();if(!key||/^(analysis$|document:|view:|annotation:)/.test(key))queueMicrotask(()=>refreshBoardMenus());if(!workspace.ready)return;
 if(!key&&workspace.localError&&!workspaceWarnings.has('local-storage')){workspaceWarnings.set('local-storage',true);notice(workspace.localError.message,true);}if(!key)return;
 const info=workspace.info(key),problem=info.conflict?'conflict':info.error?'error':null;
 if(!problem){workspaceWarnings.delete(key);return;}if(workspaceWarnings.get(key)===problem)return;workspaceWarnings.set(key,problem);
 notice(problem==='conflict'?t('Deux versions de ton travail existent. Ouvre la section correspondante pour choisir celle à conserver.'):workspace.localError?t('Le stockage de cet appareil est indisponible ou plein. Ton travail reste en mémoire : sauvegarde le PGN avant de fermer.'):t('Le brouillon est conservé sur cet appareil, mais sa synchronisation est en attente.'),true);
}
function updateWorkspaceStatus(){
 const host=document.getElementById('workspace-status');if(!host)return;
 if(currentAnalysisIsPristine()){host.dataset.state='empty';host.textContent=t('Analyse libre');host.title=t('Aucun brouillon pour cet échiquier intact.');return;}
 const identity=analysisIdentity(state.doc),info=identity&&analysisIdentity(workspace.items.get('analysis')?.data?.doc)===identity?workspace.info('analysis'):{},draft=!!state.doc&&hasAnalysisDraft(),annotationInfo=state.doc?workspace.info(drafts.key(state.doc)):{};
 const viewInfo=identity?workspace.info('view:'+identity):{},documentInfo=identity?workspace.info('document:'+identity):{};
 const conflict=info.conflict||annotationInfo.conflict||viewInfo.conflict||documentInfo.conflict,error=info.error||annotationInfo.error||viewInfo.error||documentInfo.error,synced=info.remote&&![info,annotationInfo,viewInfo,documentInfo].some(item=>item.dirty);
 host.dataset.state=conflict?'conflict':error?'error':draft?'draft':'saved';
 host.textContent=conflict?t('Brouillon · conflit'):error?t('Brouillon · à vérifier'):draft?t('Brouillon')+(synced?t(' · synchronisé'):t(' · cet appareil')):t('Enregistré');
 host.title=conflict?t('Deux versions existent. Ouvre « Gérer les brouillons » pour choisir celle à conserver.'):error?t('Le brouillon est conservé en mémoire. Vérifier sa sauvegarde.'):draft?(synced?t('Brouillon enregistré dans ChessGym; Sauvegarder l’inscrit dans le PGN.'):t('Brouillon conservé sur cet appareil; Sauvegarder l’inscrit dans le PGN.')):t('La partie est enregistrée dans sa base.');
}
async function restoreRoute(route){
 if(route.page==='training-plan')state.trainingPlanView=route.view||'today';
 if(route.page==='board'&&route.entryId){const saved=workspace.get('training-plan-active');if(saved?.run?.activity==='reading'&&Number(saved.entry_id)===Number(route.entryId)&&saved.resume_on_board)state.readingTrainingRun=saved.run;}
 if(route.page==='board'&&route.entryId&&Number(state.doc.id)!==route.entryId){
  if(!await preserveAnalysisWorkspace()||!pauseCurrentReview())return false;
  const retained=analysisSnapshot(workspace,'document:entry:'+route.entryId),last=analysisSnapshot(workspace);
  const view=workspace.get('view:entry:'+route.entryId)||retained||(Number(last?.doc?.id)===Number(route.entryId)?last:null);
  return openEntry(route.entryId,{retainCurrent:true,path:view?.path,view,navigation:view?.entryNavigation,training:!!route.training});
 }
 if(route.page==='base')state.tab=route.tab||'content';
 return navigate(route.page,{baseId:route.baseId,keepTab:route.page==='base',training:!!route.training});
}
async function restoreStartup(route,{hasRoute,startup}){
 state.trainingToolbar=!!route.training;
 if(status.capabilities?.setup_resources&&status.resources_setup_required){setupTabRequested=true;return restoreRoute({page:'settings'});}
 if(route.page==='computer')return restoreRoute(route);
 // Choose a single destination before rendering it. A second restoration after
 // mounting the route would replace clicks or annotations made on that first view.
 if(startup.resume==='auto'){
  const review=workspace.get('review');
  if(route.page==='reviews'&&review){pausedReview={...review,...reviewCallbacks(review.base.id)};return resumePausedReview();}
  const analysis=analysisSnapshot(workspace);
  if(analysis&&(!hasRoute||route.page==='board'&&!route.entryId))return restoreAnalysis(analysis,{replace:true,training:!!route.training});
  if(!hasRoute&&workspace.get(COMPUTER_WORKSPACE_KEY)?.session)return resumeComputerWorkspace();
 }
 return restoreRoute(route);
}
async function restoreAnalysis(snapshot,{replace=false,training=false}={}){
 if(!snapshot?.doc?.nodes?.length)return false;
 if(editorBusy||state.board?.busy||state.board?.inputLocked)return false;
 if(!replace&&!await preserveAnalysisWorkspace()||!pauseCurrentReview())return false;
 const copy=structuredClone(snapshot);analysisOnly=copy.studyActivity==='analysis';if(copy.doc.id&&!Array.isArray(copy.doc.analysis_source_line)){copy.doc.analysis_source_line=[];copy.doc.analysis_dirty=true;}teardown();state.trainingToolbar=training;state.doc=copy.doc;state.path=copy.doc.nodes.some(n=>n.path===copy.path)?copy.path:'';state.page='board';state.entryNavigation=copy.entryNavigation||null;state.analysisTool=copy.analysisTool||'explorer';state.analysisMobilePanel=copy.analysisMobilePanel||'moves';analysisWorkspace={...copy,doc:state.doc};freeHistory.reset(state.doc,state.path);render();persistAnalysis();
 if(state.doc.id){try{const fresh=await api('/api/entries/'+state.doc.id);if(state.doc===copy.doc){if(fresh.revision!==copy.doc.revision){copy.doc.analysis_source_line=[];copy.doc.analysis_dirty=true;notice(t('La partie a changé dans la base. Ton brouillon est conservé; enregistre une copie ou recharge la partie avant de modifier la version de la base.'),true);}else{copy.doc.analysis_source_line=mainlineNodes(fresh).map(({path,fen})=>({path,fen}));copy.doc.analysis_dirty=serialize(copy.doc)!==serialize(fresh)||copy.doc.title!==fresh.title||(copy.doc.start_path||'')!==(fresh.start_path||'');}persistAnalysis();}}catch(error){if(error.status===404)notice(t('La partie source a été supprimée. Ton brouillon reste disponible pour en sauvegarder une copie.'),true);else throw error;}}
 return true;
}
function refreshBoardMenus(){
 if(boardDraftMenu?.menu)return;
 const hosts=[...document.querySelectorAll('[data-board-menu][open] [data-board-menu-content]')];if(!hosts.length)return;
 const html=boardMenuHtml(boardMenuModel({store:workspace,doc:state.doc,entryNavigation:state.entryNavigation,bases:state.library.bases}));
 for(const host of hosts){if(boardMenuMarkup.get(host)===html)continue;boardMenuMarkup.set(host,html);const focus=host.contains(document.activeElement)?document.activeElement:null,command=focus?.dataset.boardCommand,recent=focus?.dataset.boardRecent,draftOptions=focus?.dataset.boardDraftOptions,details=host.querySelector('details'),expanded=details?.open,scroll=host.scrollTop;host.innerHTML=html;if(expanded!==undefined&&host.querySelector('details'))host.querySelector('details').open=expanded;host.scrollTop=scroll;if(focus)[...host.querySelectorAll('button')].find(button=>draftOptions?button.dataset.boardDraftOptions===draftOptions:recent?button.dataset.boardRecent===recent:button.dataset.boardCommand===command)?.focus({preventScroll:true});}
}
async function newAnalysisBoard(){
 reportSession?.dispose();
 if(editorBusy||state.board?.busy||state.board?.inputLocked)return false;
 const request=++documentRequest;await readingTracker?.settle();await analysisTimeTracker?.settle();if(request!==documentRequest)return false;
 if(!await preserveAnalysisWorkspace()||request!==documentRequest||!pauseCurrentReview())return false;
 teardown();state.doc=makeDoc();state.path='';state.entryNavigation=null;analysisWorkspace=null;state.page='board';freeHistory.reset(state.doc,'');render();return true;
}
async function boardMenuAction(command,identity){
 boardDraftMenu?.close();reportSession?.dispose();
 if(command==='manage')return showDraftManager();
 state.trainingToolbar=false;trainingSessionBar?.render();sectionNavigation.commit(currentRoute());
 if(command==='new')return newAnalysisBoard();
 if(command==='library'){state.folder=null;return navigate('library');}
 if(command==='current'){if(state.page==='board'){documentRequest++;return true;}return navigate('board');}
 if(!identity||!/^entry:[1-9]\d*$|^free:[A-Za-z0-9-]+$/.test(identity)||editorBusy||state.board?.busy||state.board?.inputLocked)return false;
 if(!await preserveAnalysisWorkspace()||!pauseCurrentReview())return false;
 const key='document:'+identity,retained=analysisSnapshot(workspace,key),last=analysisSnapshot(workspace);
 const snapshot=retained?.doc?retained:analysisIdentity(last?.doc)===identity&&hasAnalysisDraft(last.doc)?last:null;
 if(snapshot?.doc){if(identity.startsWith('free:')&&!snapshot.doc.id&&!snapshot.doc.workspace_id)snapshot.doc.workspace_id=identity.slice(5);return restoreAnalysis(snapshot);}
 const view=workspace.get('view:'+identity);
 if(identity.startsWith('entry:'))return openEntry(Number(identity.slice(6)),{retainCurrent:true,path:view?.path,view,navigation:view?.entryNavigation});
 // A free board can only be resumed from its retained document, never reconstructed from a label.
 notice(t('Ce brouillon n’est plus disponible. Rouvre le menu pour actualiser la liste.'),true);return false;
}

function boardDraftState(identity){
 if(typeof identity!=='string'||!/^entry:[1-9]\d*$|^free:[A-Za-z0-9-]+$/.test(identity))return null;
 const model=boardMenuModel({store:workspace,doc:state.doc,entryNavigation:state.entryNavigation,bases:state.library.bases});
 const item=[model.current,...model.recents].find(item=>item.identity===identity);
 return item?.draft&&item.snapshotKey?item:null;
}
function applyRenameBoardDraft(identity,label){
 const name=typeof label==='string'?label.trim():'';
 if(!name||name.length>160)throw new Error(t('Indique un nom de brouillon de 1 à 160 caractères.'));
 if(editorBusy||state.board?.busy||state.board?.inputLocked)return false;
 captureAnnotation();persistAnalysis();
 if(!boardDraftState(identity))throw new Error(t('Ce brouillon n’est plus disponible.'));
 const key='view:'+identity,view=workspace.get(key)||{};
 workspace.set(key,{...view,draftLabel:name});refreshBoardMenus();notice(t('Brouillon renommé.'));return true;
}
function renameBoardDraft(identity){
 reportSession?.dispose();captureAnnotation();persistAnalysis();
 const item=boardDraftState(identity);if(!item)return false;
 const epoch=workspace.epoch,account=loadedWorkspaceIdentity;
 return modal(t('Renommer le brouillon…'),field(t('Nom du brouillon'),'draft_name',item.title,'text','required maxlength="160" autocomplete="off"')+'<p class="hint">'+esc(t('Ce nom sert uniquement à retrouver ton brouillon. Le titre de la partie dans la base reste inchangé.'))+'</p>',{submit:t('Renommer'),onSubmit:form=>{
  if(epoch!==workspace.epoch||account!==loadedWorkspaceIdentity)throw new Error(t('L’espace ouvert a changé.'));
  return applyRenameBoardDraft(identity,form.get('draft_name'));
 }});
}
async function deleteBoardDraft(identity){
 reportSession?.dispose();captureAnnotation();persistAnalysis();
 const item=boardDraftState(identity);if(!item)return false;
 const deleted=await deleteWorkspaceDraft(item.snapshotKey);refreshBoardMenus();return deleted;
}

async function resumeComputerWorkspace(){
 if(!workspace.get(COMPUTER_WORKSPACE_KEY)?.session)return false;
 if(trainingViewPage==='computer'){
  persistComputer();trainingView?.dispose();trainingView=null;trainingViewPage=null;
 }
 computerSnapshot=workspace.get(COMPUTER_WORKSPACE_KEY);computerLaunch=null;
 return navigate('computer');
}
async function resolveWorkspaceVersion(key,choice){
 if(key===COMPUTER_WORKSPACE_KEY){
  // Stop callbacks before choosing a version: teardown must never recapture the
  // old board over the explicitly chosen remote snapshot.
  const epoch=workspace.epoch;
  if(trainingViewPage==='computer'){persistComputer();trainingView?.dispose();trainingView=null;trainingViewPage=null;}
  try{await workspace.resolve(key,choice);if(epoch!==workspace.epoch)return;computerSnapshot=workspace.get(key);computerLaunch=null;}
  finally{if(epoch===workspace.epoch&&state.page==='computer')render();}
  return;
 }
 await workspace.resolve(key,choice);
 if(choice==='remote'){
  if(key==='analysis'&&workspace.get(key))await restoreAnalysis(workspace.get(key),{replace:true});
  else if(key.startsWith('document:')&&analysisIdentity(state.doc)===key.slice(9)&&workspace.get(key)?.doc)await restoreAnalysis(analysisSnapshot(workspace,key),{replace:true});
  else if(key===drafts.key(state.doc)&&state.board){annotationContext=null;renderBoardPanels();}
  else if(key==='review')pausedReview=null;
 }
}
function showWorkspaceConflicts(keys){
 const pending=keys.filter(key=>workspace.info(key)?.conflict);if(!pending.length)return;
 const dialog=modal(t('Choisir la version à conserver'),workspaceConflictHtml(pending));
 dialog.querySelectorAll('[data-resolve-key]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await resolveWorkspaceVersion(button.dataset.resolveKey,button.dataset.choice);dialog.close();showWorkspaceConflicts(keys);}catch(error){fail(error);button.disabled=false;}});
 return dialog;
}
function showDraftManager(){
 captureAnnotation();persistAnalysis();pruneEmptyAnalyses(workspace);
 const rows=draftManagerModel({store:workspace,doc:state.doc,bases:state.library.bases});
 const dialog=modal(t('Gérer les brouillons'),'<section data-draft-collection>'+draftManagerHtml(rows)+'</section>');
 const draftHost=dialog.querySelector('[data-draft-collection]');const draftList=rows.length?new CollectionList(draftHost,{stateKey:'drafts',placeholder:'Rechercher un brouillon…',items:[...draftHost.querySelectorAll('.workspace-draft-row')].map((node,index)=>({node,text:[rows[index].title,rows[index].baseName].join(' '),values:{conflict:rows[index].conflicts.length?'yes':'no'},sort:{order:index,name:rows[index].title,updated:rows[index].updatedAt||''}})),filters:[{key:'conflict',label:'Conflit',options:[['yes','Avec conflit'],['no','Sans conflit']]}],sorts:[['order','Ordre récent'],['updated','Date de modification'],['name','Nom']]}):null;dialog.addEventListener('close',()=>draftList?.dispose(),{once:true});
 const epoch=workspace.epoch,account=loadedWorkspaceIdentity;
 const current=()=>epoch===workspace.epoch&&account===loadedWorkspaceIdentity;
 const close=dialog.querySelector('.dialog-actions [data-close]');if(close)close.textContent=t('Fermer');
 dialog.querySelectorAll('[data-resolve-key]').forEach(button=>button.onclick=async()=>{if(!current())return;button.disabled=true;try{await resolveWorkspaceVersion(button.dataset.resolveKey,button.dataset.choice);if(current())showDraftManager();}catch(error){fail(error);button.disabled=false;}});
 dialog.querySelectorAll('[data-delete-workspace]').forEach(button=>button.onclick=async()=>{if(!current())return;button.disabled=true;try{if(await deleteWorkspaceDraft(button.dataset.deleteWorkspace)&&current())showDraftManager();}catch(error){fail(error);}finally{button.disabled=false;}});
 dialog.querySelectorAll('[data-workspace-document]').forEach(button=>button.onclick=async()=>{if(!current())return;try{
  const key=button.dataset.workspaceDocument,row=rows.find(row=>row.key===key);
  if(row?.identity&&row.identity===analysisIdentity(state.doc)){if(await boardMenuAction('current'))dialog.close();return;}
  const snapshot=analysisSnapshot(workspace,key);if(snapshot?.doc&&!snapshot.doc.id&&!snapshot.doc.workspace_id&&key.startsWith('document:free:'))snapshot.doc.workspace_id=key.slice(14);
  if(await restoreAnalysis(snapshot)&&current())dialog.close();
 }catch(error){fail(error);}});
 return dialog;
}
async function resumeReviewWorkspace({training=!!state.trainingToolbar}={}){
 if(reviewBoard())return navigate('reviews',{training});
 if(workspace.info('review')?.conflict)return showWorkspaceConflicts(['review']);
 const saved=workspace.get('review');
 if(!saved?.base||reviewSessionFinished(saved))return navigate('reviews',{training});
 pausedReview={...saved,...reviewCallbacks(saved.base.id)};return resumePausedReview({training});
}
async function navigateMenu(page){
 if(page==='reviews'&&unfinishedActivities().has('reviews')&&workspace.get('review'))return resumeReviewWorkspace({training:false});
 return navigate(page);
}

async function deleteWorkspaceDraft(key){
 if(editorBusy||state.board?.busy||state.board?.inputLocked)return false;
 captureAnnotation();persistAnalysis();
 const snapshot=analysisSnapshot(workspace,key);if(!snapshot?.doc)return false;
 const identity=analysisIdentity(snapshot.doc)||(key.startsWith('document:')?key.slice(9):null),current=!!identity&&analysisIdentity(state.doc)===identity;
 if(!isPristineAnalysis(snapshot,annotationFor(workspace,snapshot,key))&&!confirm(current?t('Supprimer ce brouillon et ses annotations non enregistrées ? L’échiquier actuel sera réinitialisé; les parties enregistrées dans les bases sont conservées.'):t('Supprimer ce brouillon et ses annotations non enregistrées ? Les parties enregistrées dans les bases sont conservées.')))return false;
 const board=state.board,epoch=workspace.epoch,account=loadedWorkspaceIdentity,sourceDoc=state.doc,oldRestoring=workspaceRestoring;
 const keys=draftKeys(workspace,key),versions=new Map(keys.map(key=>[key,workspace.items.get(key)?.version]));
 const inputs=current?[...(document.getElementById('annotation-form')?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled})):[];
 editorBusy=true;workspaceRestoring=true;if(board)board.inputLocked=true;inputs.forEach(({input})=>input.disabled=true);updateEditorToolbar();
 try{
  let fresh=null;
  if(current&&state.doc.id){try{fresh=prepareSavedAnalysis(await api('/api/entries/'+state.doc.id));}catch(error){if(error.status!==404)throw error;}}
  if(epoch!==workspace.epoch||account!==loadedWorkspaceIdentity||current&&state.doc!==sourceDoc)return false;
  const currentKeys=draftKeys(workspace,key);
  if(currentKeys.length!==keys.length||currentKeys.some(key=>!versions.has(key)||workspace.items.get(key)?.version!==versions.get(key)))throw new Error(t('Le brouillon a changé. Rouvre le menu avant de le supprimer.'));
  await workspace.discard(keys);
  if(epoch!==workspace.epoch)return false;
  if(identity&&analysisIdentity(analysisWorkspace?.doc)===identity)analysisWorkspace=null;
  if(current&&analysisIdentity(state.doc)===identity){
   annotationContext=null;
   if(fresh){state.doc=fresh;state.path=fresh.nodes.some(node=>node.path===state.path)?state.path:fresh.start_path||'';freeHistory.reset(state.doc,state.path);}
   else{state.doc=makeDoc();state.path='';state.entryNavigation=null;freeHistory.reset(state.doc,state.path);}
   if(state.page==='board')render();
  }
  notice(t('Brouillon supprimé.'));return true;
 }finally{
  workspaceRestoring=oldRestoring;editorBusy=false;if(board)board.inputLocked=false;inputs.forEach(({input,disabled})=>input.disabled=disabled);if(state.board)updateEditorToolbar();
 }
}

const base=()=>state.library.bases.find(x=>x.id===state.baseId);
let libraryLoadedFor=null;
async function loadLibrary(){const user=status?.username,result=await api('/api/library');if(status?.username!==user)return;state.library=result;libraryLoadedFor=user;positionPanel?.update({force:true});}
function button(text,action,cls=''){return ui('<button class="')+cls+'" data-action="'+action+'">'+text+ui('</button>');}
function title(text,sub='',actions=''){return ui('<div class="page-title"><div><h1>')+esc(text)+ui('</h1>')+(sub?ui('<p class="muted">')+esc(sub)+ui('</p>'):'')+ui('</div><div class="actions">')+actions+ui('</div></div>');}
function empty(text,detail,actions=''){return ui('<div class="empty"><span class="empty-icon">♘</span><h2>')+esc(text)+ui('</h2><p>')+esc(detail)+ui('</p><div class="actions">')+actions+ui('</div></div>');}
function folderLabel(id){const seen=new Set();let out=[];while(id){if(seen.has(id))break;seen.add(id);const f=state.library.folders.find(x=>x.id===id);if(!f)break;out.unshift(f.name);id=f.parent_id;}return out.join(t(' / '));}
function folderOptions(selected,none=t('Sans dossier')){return option('',none,selected??'')+state.library.folders.map(f=>option(f.id,folderLabel(f.id),selected)).join('');}
function studyBases(){return state.library.bases.filter(b=>!b.reference);}
function baseOptions(selected){return studyBases().map(b=>option(b.id,b.name,selected)).join('');}
function badge(text){return ui('<span class="badge">')+esc(text)+ui('</span>');}
function disposePageViews(){
 boardRecentPreview?.dispose();boardRecentPreview=null;
 collectionView?.dispose();collectionView=null;
 trainingSessionBar?.dispose();trainingSessionBar=null;
 toolbarRunCache=toolbarRunRequest=null;toolbarRunRefresh=0;toolbarRunSource=null;toolbarProgress.reset();
 activityHistoryDialog?.close();activityHistoryDialog=null;
 engineManager?.dispose();engineManager=null;
 setupResources?.dispose();setupResources=null;
 appUpdates?.dispose();appUpdates=null;
 privateAccess?.dispose();privateAccess=null;
 reportSession?.dispose({restore:false});reportSession=null;
 captureAnnotation();
 if(trainingViewPage==='computer'&&trainingView?.snapshot){trainingView.pauseGame?.({render:false,explicit:false});persistComputer(trainingView.snapshot());}
 disposeViews([boardDraftMenu,mainNavigation,trainingView,activityHistory,readingTracker,analysisTimeTracker,referenceLibrary,positionPanel,coveragePanel,mobileAnalysis,libraryMenu,libraryDrag,baseAppearanceEditor,reviewStatistics,entryTable,playedGames,gameAnalysis,analysisCharts,readingControls,analysisResize,repertoirePanel,explorer,moveMenu,state.board]);
 analysisTimeTracker=readingTracker=referenceLibrary=positionPanel=coveragePanel=mobileAnalysis=libraryMenu=libraryDrag=baseAppearanceEditor=reviewStatistics=entryTable=playedGames=gameAnalysis=analysisCharts=analysisReport=readingControls=analysisResize=repertoirePanel=explorer=moveMenu=state.board=null;
 annotationContext=null;boardDraftMenu=mainNavigation=trainingView=trainingViewPage=activityHistory=null;
}
function teardown(){documentRequest++;trainingRecordLaunch=null;disposePageViews();stopReview();boardVisit=null;}
function switchWorkspaceIdentity(identity){
 if(identity===loadedWorkspaceIdentity)return;
 reportProgress.close();
 // Never replay an editor or a delayed reading heartbeat into another account
 // or into a restored database that happens to reuse the same entry IDs.
 sectionNavigation.stop();annotationContext=null;resetReadingContext();resetAnalysisContext();readingTracker?.dispose({flush:false});analysisTimeTracker?.dispose({flush:false});analysisOnly=false;teardown();
 state.doc=makeDoc();state.path='';state.entryNavigation=null;state.entries=[];state.library={folders:[],bases:[]};state.baseId=null;state.filter='';state.folder=null;state.page='library';state.tab='content';state.readingBases=[];state.reviews=[];trainingLaunch=null;
 pausedReview=analysisWorkspace=null;reviewNavigationReady=false;resumingReview=false;entryNavigationBusy=false;entryNavigationLoad=null;editorBusy=false;libraryLoadedFor=null;markingEntriesSeen.clear();workspaceWarnings.clear();freeHistory.reset(state.doc,'');loadedWorkspaceIdentity=identity;setListOwner(identity);
 computerSnapshot=computerLaunch=trainingRecordLaunch=null;remoteActivities=[];reviewDueCount=null;activityRequest=null;computerHistory.close();state.readingTrainingRun=null;state.trainingPlanView='today';state.trainingToolbar=false;
}
async function preserveAnalysisWorkspace(){
 reportSession?.dispose();
 const board=state.board;
 if(state.page!=='board'||!board||board.doc!==state.doc)return true;
 const cancellingEntryOpen=entryNavigationBusy&&board.inputLocked&&!editorBusy&&!board.busy;
 if((editorBusy||board.busy||board.inputLocked)&&!reviewNavigationReady&&!cancellingEntryOpen)return false;
 const request=documentRequest;
 if(!reviewNavigationReady&&!cancellingEntryOpen){
  captureAnnotation();
  persistAnalysis();
 }
 if(request!==documentRequest||state.board!==board||board.disposed)return false;
 analysisWorkspace={doc:state.doc,path:board.path,flipped:board.flipped,engineOn:board.engineOn,arrows:board.arrows,drawings:structuredClone(board.drawings||[]),studyActivity:analysisOnly?'analysis':null,analysisPaused:!!analysisTimeTracker?.paused};
 return true;
}
function pauseCurrentReview(){
 if(!reviewBoard()&&!snapshotReview())return true;
 const snapshot=suspendReview({assisted:false});
 if(!snapshot){notice(t('Patiente jusqu’à la fin du coup en cours.'));return false;}
 pausedReview=snapshot;persistReview(snapshot);return true;
}
async function navigate(page,{baseId=null,keepTab=false,historyRecord=null,view=null,training=false}={}){
 const explicitAnalysis=page==='analysis';if(explicitAnalysis)page='board';
 const navigationRequest=++documentRequest;
 document.querySelectorAll('.mobile-navigation-group[open]').forEach(menu=>menu.open=false);
 await readingTracker?.settle();await analysisTimeTracker?.settle();if(navigationRequest!==documentRequest)return false;
 if(page==='reviews'){if(reviewBoard()){state.trainingToolbar=training;trainingSessionBar?.render();sectionNavigation.commit(currentRoute());return true;}if(pausedReview)return resumePausedReview({training});}
 if(!await preserveAnalysisWorkspace()||navigationRequest!==documentRequest||!pauseCurrentReview())return false;
 if(explicitAnalysis){analysisOnly=true;state.readingTrainingRun=null;workspace.remove('reading-toolbar');}
 else if(page!=='board')analysisOnly=false;
 if(page!=='board'&&state.readingTrainingRun){const saved=workspace.get('training-plan-active');if(saved?.run?.id===state.readingTrainingRun.id)workspace.set('training-plan-active',{...saved,resume_on_board:false});state.readingTrainingRun=null;}
 if(page!=='board'&&workspace.get('reading-toolbar'))workspace.remove('reading-toolbar');
 if(page==='training-plan'&&view)state.trainingPlanView=view;
 teardown();trainingRecordLaunch=historyRecord?{record:historyRecord,page,identity:loadedWorkspaceIdentity}:null;state.trainingToolbar=training;state.page=page;if(baseId!=null)state.baseId=Number(baseId);if(!keepTab)state.tab='content';state.filter='';await refresh();return true;
}
async function refresh(){
 const request=documentRequest,page=state.page,baseId=state.baseId;
 const current=()=>request===documentRequest&&page===state.page&&baseId===state.baseId;
 try{
  await flushReadingWrites();await flushAnalysisWrites();if(!current())return;if(!['board','settings'].includes(page)||libraryLoadedFor!==status.username)await loadLibrary();if(!current())return;
  if(page==='reading'){const result=await api('/api/reading');if(!current())return;state.readingBases=result.bases;}
  if(page==='board'&&state.doc.id){const doc=state.doc,reading=await api('/api/entries/'+doc.id+'/reading');if(!current())return;if(state.doc===doc)doc.reading=reading;}
  if(page==='base'){if(!base())state.page='library';else if(base().reference)state.entries=[];else if(status.capabilities?.entry_pagination)state.entries=[];else{const result=await api('/api/bases/'+baseId+'/entries');if(!current())return;state.entries=result.entries;}}
  if(page==='played'){if(status.capabilities?.entry_pagination)state.entries=[];else{const result=await api('/api/entries?played=true');if(!current())return;state.entries=result.entries;}}
  if(page==='reviews'||page==='repertoire'){const result=await api('/api/reviews');if(!current())return;state.reviews=result.bases;}
  render();
 }catch(e){if(!current())return;if(e.status===401)return boot();fail(e);}
}
const trainingPages=new Set(['exercises','puzzles','guess','blindfold','coordinates','color','computer','computer-history','training-history','training-plan']);
function render({reviewSession=false}={}){
 documentRequest++;disposePageViews();sectionNavigation.commit(currentRoute());
 const boardMenu=boardMenuHtml(boardMenuModel({store:workspace,doc:state.doc,entryNavigation:state.entryNavigation,bases:state.library.bases})),activities=unfinishedActivities();
 const pageLabel=state.page==='board'?'<div id="analysis-entry-nav-mobile" class="mobile-page-label">'+(entryNavigationHtml(state.entryNavigation,state.doc,{mobile:true})||t('Analyse'))+'</div>':trainingPages.has(state.page)?'<div class="mobile-page-label">'+esc(navigationLabel(state.page))+'</div>':'';
 app.innerHTML='<header class="topbar">'+mobileNavigationHtml(state.page,{boardMenu,unfinishedActivities:activities,reviewDueCount})+ui('<button class="brand" data-page="library" aria-label="Chess Gym, bibliothèque"><picture><source media="(max-width:850px), (max-width:1000px) and (max-height:500px)" srcset="/static/icons/chessgym-32.png?v=1"><img src="/static/logo.png" alt="Chess Gym"></picture></button>')+pageLabel+desktopNavigationHtml(state.page,{boardMenu,unfinishedActivities:activities,reviewDueCount})+ui('<div class="top-actions"><button data-page="settings" title="Réglages" aria-label="Réglages" aria-current="')+(state.page==='settings'?'page':'false')+ui('">⚙ <span>Réglages</span></button></div></header><div class="shell"><main id="main" class="')+(state.page==='board'?'analysis-page':(trainingPages.has(state.page)||['reviews','reading'].includes(state.page))?'training-page':'')+'">'+(reviewSession?ui('<div class="loading">Préparation de la révision…</div>'):content())+'</main></div>';
 document.querySelectorAll('[data-board-menu-content]').forEach(host=>boardMenuMarkup.set(host,boardMenu));
 bind();mainNavigation=bindMainNavigation(document.querySelector('.topbar'),{onOpen:()=>{void refreshUnfinishedActivities();},onBoardOpen:()=>{captureAnnotation();persistAnalysis();refreshBoardMenus();},onBoardAction:(command,identity)=>{void boardMenuAction(command,identity).catch(fail);}});
 boardDraftMenu=new BoardDraftMenu(document.querySelector('.topbar'),{getDraft:identity=>{captureAnnotation();persistAnalysis();return boardDraftState(identity);},onAction:async(identity,action)=>{try{return action==='rename'?renameBoardDraft(identity):action==='delete'?await deleteBoardDraft(identity):false;}catch(error){fail(error);return false;}}});
 boardRecentPreview=new BoardRecentPreview(document.querySelector('.topbar'),{getPosition:(row,{signal})=>boardRecentPosition({identity:row.dataset.boardRecent||analysisIdentity(state.doc),store:workspace,currentDoc:state.doc,currentPath:state.board?.doc===state.doc?state.board.path:state.path,currentFlipped:state.board?.doc===state.doc?state.board.flipped:analysisWorkspace?.doc===state.doc?analysisWorkspace.flipped:undefined,request:api,signal})});
 collectionView=mountCollectionView({main:document.getElementById('main'),page:state.page,bases:state.library.bases,readingBases:state.readingBases,reviews:state.reviews,folder:state.folder});
 if(state.page==='reading')bindTrainingTabs(document.getElementById('main'));
 if(state.page==='library')bindLibraryMenu();
 if(state.page==='reviews'&&!reviewSession){bindReviewNavigation();if(state.reviewView==='statistics')mountReviewStatistics();if(state.reviewView==='history')mountReviewHistory();}
 if(state.page==='base'&&state.tab==='content'){if(base().reference)mountReferenceLibrary();else mountEntryTable();}
 if(state.page==='played'&&status.capabilities?.entry_pagination)mountPlayedEntryTable();
 if(state.page==='played')playedGames=new PlayedGamesPanel(document.getElementById('played-games-tools'),{getBases:studyBases,onLibraryChange:loadLibrary,onGamesChanged:()=>refresh(),onOpenEntry:openEntry});
 if(state.page==='board')mountBoard();if(state.page==='base'&&state.tab==='settings')bindBaseSettings();if(state.page==='base'&&state.tab==='coverage')mountCoverage();if(state.page==='settings')bindPreferences();
 void refreshUnfinishedActivities();
 if(trainingPages.has(state.page))void mountTrainingView();
 // Launch origin controls presentation only; native clocks and time receipts
 // continue independently when an activity is opened through ordinary menus.
 if(state.page==='reviews'||state.page==='board'||isNativeTraining(state.page))trainingSessionBar=new TrainingSessionBar(document.querySelector('.topbar'),{observeHost:document.getElementById('main'),getContext:()=>state.trainingToolbar?trainingToolbarContext():null,onAction:trainingToolbarAction});
}
function content(){
 if(trainingPages.has(state.page))return '<div id="training-view"><div class="loading">'+t('Préparation de l’entraînement…')+'</div></div>';
 if(state.page==='reading')return ui('<header class="page-title training-header"><div class="training-header-copy"><h1>Lecture</h1><p class="muted">Tes cours et recueils, un signet à la fois.</p></div><nav class="tabs training-tabs" aria-label="Lecture"><span class="training-tab" aria-current="page">Lecture</span><button type="button" data-reading-history data-training-history>Historique</button></nav></header>')+readingDashboardHtml(state.readingBases);
 if(state.page==='base')return basePage();if(state.page==='played')return title(t('Mes parties'),t('Tes parties importées et synchronisées, prêtes à analyser.'))+ui('<section id="played-games-tools"></section>')+(status.capabilities?.entry_pagination?'<section id="played-entry-table"></section>':gameTable(state.entries));if(state.page==='board')return boardPage();if(state.page==='reviews')return reviewsPage();if(state.page==='repertoire')return repertoiresPage();if(state.page==='settings')return settingsPage();return libraryPage();
}
async function openTrainingAnalysis(value){
 let doc=value?.doc||value,path=value?.path||'';
 if(!doc?.nodes){doc=await api('/api/board',{method:'POST',body:value?.pgn?{pgn:value.pgn}:{fen:value?.fen||START}});}
 return showEngineWorkspace(doc,doc.nodes.some(node=>node.path===path)?path:'');
}
async function openTrainingRecord(record){
 const entryId=Number(record.metrics?.entry_id);
 if(['reading','review'].includes(record.tool)){
  if(!entryId)throw new Error(t('La partie source n’est plus disponible.'));
  return openEntry(entryId,{path:record.tool==='reading'?record.metrics?.last_path:record.metrics?.path});
 }
 const page=({computer:'computer-history',storm:'puzzles',puzzles:'puzzles',guess:'guess',coordinates:'coordinates',blindfold:'blindfold',color:'color'})[record.tool];
 if(!page)return;return navigate(page,{historyRecord:record});
}
async function showReadingHistory(){
 const request=documentRequest,identity=loadedWorkspaceIdentity;
 const current=()=>request===documentRequest&&identity===loadedWorkspaceIdentity;
 activityHistoryDialog?.close();
 const dialog=await openTrainingHistory({host:document.getElementById('main'),tool:'reading',onOpen:record=>current()?openTrainingRecord(record):false,title:t('Historique de lecture')});
 if(!current()){dialog.close();return;}activityHistoryDialog=dialog;
 dialog.addEventListener('close',()=>{if(activityHistoryDialog===dialog)activityHistoryDialog=null;},{once:true});
}
function mountReviewHistory(){
 activityHistory=new TrainingHistoryView(document.getElementById('review-history'),{tool:'review',embedded:true,onOpen:openTrainingRecord});void activityHistory.load();
}
function computerModeSettings(){
 const request=documentRequest,page=state.page;
 return openComputerSettings({bases:studyBases,isCurrent:()=>request===documentRequest&&page===state.page});
}
async function computerModeStatistics(){
 const request=documentRequest,page=state.page,identity=loadedWorkspaceIdentity;
 if(page==='computer')persistComputer();
 await computerHistory.flush();
 if(request!==documentRequest||page!==state.page||identity!==loadedWorkspaceIdentity)return null;
 return openTrainingStatistics({host:page==='computer'?document.getElementById('training-view'):null,tool:'computer'});
}
async function openComputerHistory(historyRecord=null){
 const request=documentRequest,identity=loadedWorkspaceIdentity;
 persistComputer();await computerHistory.flush();
 if(request!==documentRequest||identity!==loadedWorkspaceIdentity)return false;
 return navigate('computer-history',{historyRecord});
}
async function resumeComputerHistory(snapshot,archive){
 const request=documentRequest,identity=loadedWorkspaceIdentity;
 const current=()=>request===documentRequest&&identity===loadedWorkspaceIdentity;
 // Flush both the retained game and this archive before explicitly replacing
 // the workspace. A stale history screen must never discard an offline move.
 if(computerSessionSnapshot(computerSnapshot))await computerHistory.archive(computerSnapshot);
 if(!current())return false;
 await computerHistory.flush(archive.id);if(!current())return false;
 const info=computerHistory.info(archive.id);
 if(info.pending||info.conflict)throw new Error(info.error||t('La synchronisation de cette partie est en attente.'));
 const latest=await api('/api/computer/games/'+encodeURIComponent(archive.id));if(!current())return false;
 computerHistory.adopt(latest);computerSnapshot=latest.snapshot;computerLaunch=null;
 const activeProgram=workspace.get('training-plan-active');
 if(activeProgram?.resume_on_tool)workspace.set('training-plan-active',{...activeProgram,resume_on_tool:false});
 persistComputer(computerSnapshot);await workspace.flush();if(!current())return false;return navigate('computer');
}
async function mountTrainingView(){
 const request=documentRequest,page=state.page,host=document.getElementById('training-view');
 const launch=trainingRecordLaunch;trainingRecordLaunch=null;
 const historyRecord=launch?.page===page&&launch.identity===loadedWorkspaceIdentity?launch.record:null;
 const current=()=>request===documentRequest&&state.page===page&&host.isConnected;
 try{
  if(page==='exercises'){trainingViewPage=page;host.innerHTML=exerciseCatalogHtml(unfinishedActivities());host.querySelectorAll('[data-exercise-page]').forEach(button=>button.onclick=()=>void navigateMenu(button.dataset.exercisePage).catch(fail));return;}
  if(page==='training-plan'){
   const {TrainingPlan}=await import('./training-plan.js');if(!current())return;
   trainingViewPage=page;
   const panel=trainingView=new TrainingPlan(host,{request:api,view:state.trainingPlanView||'today',draft:workspace.get('training-program-draft'),isCurrent:current,
    onDraft:value=>{if(current())value?workspace.set('training-program-draft',value):workspace.remove('training-program-draft');},
    onRoute:view=>{if(current()){state.trainingPlanView=view;sectionNavigation.commit(currentRoute());}},
    onLaunch:launchProgramRun,onNavigate:page=>navigate(page,{training:isNativeTraining(page)||['analysis','board','reviews','reading'].includes(page)})});
   await panel.load();return;
  }
  if(page==='training-history'){trainingViewPage=page;const panel=trainingView=new TrainingHistoryView(host,{onOpen:openTrainingRecord,title:t('Historique des entraînements')});await panel.load();return;}
  if(page==='computer-history'){
   trainingViewPage=page;
   const panel=trainingView=new ComputerHistoryView(host,{onResume:resumeComputerHistory,onAnalyse:openTrainingAnalysis,onBack:()=>navigate('computer'),bases:studyBases,onSettings:computerModeSettings,onStatistics:computerModeStatistics});
   await computerHistory.flush();if(current()){await panel.load();if(current()&&historyRecord)await panel.openTrainingRecord(historyRecord);}return;
  }
  const module=await import(page==='color'?'./color-training.js':page==='computer'?'./computer-play.js':page==='guess'?'./guess-move.js':page==='puzzles'?'./puzzles.js':'./training-skills.js');if(!current())return;
  const View=page==='color'?module.ColorTrainingView:page==='computer'?module.ComputerPlayView:page==='guess'?module.GuessMoveView:page==='puzzles'?module.PuzzleView:page==='blindfold'?module.BlindfoldView:module.CoordinateView;
  let snapshot=computerSnapshot||workspace.get(COMPUTER_WORKSPACE_KEY);
  if(page==='computer'&&!computerLaunch){snapshot=await computerHistory.prepare(snapshot);if(!current())return;computerSnapshot=snapshot;}
  trainingViewPage=page;
  const panel=trainingView=new View(host,{initialSettings:workspace.get('training-settings-'+page),onSettingsChange:value=>{if(current())workspace.set('training-settings-'+page,value);},onLibrary:()=>current()?navigate('library'):undefined,onAnalyse:openTrainingAnalysis,onAnalyze:openTrainingAnalysis,onArchive:value=>computerHistory.archive(value),onHistory:record=>{if(current())void openComputerHistory(record).catch(fail);},onSettings:computerModeSettings,onStatistics:computerModeStatistics,onChange:value=>{if(page==='computer'&&current())persistComputer(value);},onRender:()=>{if(page==='computer'&&current())updateComputerWorkspaceStatus();}});
  panel.trainingActivity=page;
  const activeProgram=workspace.get('training-plan-active');
  const programLaunch=activeProgram?.resume_on_tool&&activeProgram.run?.activity===page&&!historyRecord&&!computerLaunch&&!(page==='guess'&&trainingLaunch);
  if(programLaunch){
   const run=await api('/api/training/runs/'+encodeURIComponent(activeProgram.run.id));if(!current())return;
   if(['completed','cancelled'].includes(run.state)||run.state==='paused'&&!activeProgram.toolbar_paused)throw new Error(t('Reprends ce bloc depuis Mon entraînement pour retrouver son contexte actuel.'));
   workspace.set('training-plan-active',{...activeProgram,run});
   await launchNativeProgram(panel,run,{request:api,store:workspace,computerSnapshot:snapshot});
   if(page==='computer'&&current())persistComputer(panel.snapshot());
  }
  else if(page==='computer'&&computerLaunch){const launch=computerLaunch;computerLaunch=null;await panel.launch(launch);}
  else if(page==='computer'){await panel.load(snapshot);if(current())persistComputer(panel.snapshot());}
  else if(page==='guess'&&trainingLaunch){const launch=trainingLaunch;trainingLaunch=null;await panel.launch(launch);}else if(panel.load)await panel.load();else await panel.mount();
  if(current()&&historyRecord)await panel.openTrainingRecord?.(historyRecord);
 }catch(error){if(current()){trainingView?.dispose();host.innerHTML='<div class="empty"><p>'+esc(error.message)+'</p><button type="button" data-retry-training>'+t('Réessayer')+'</button></div>';host.querySelector('[data-retry-training]').onclick=()=>{void mountTrainingView();};fail(error);}}
}
function programSessionContext(){
 const tool=isNativeTraining(state.page)?nativeProgramContext(trainingView):null;
 if(tool){const active=workspace.get('training-plan-active')?.run;return {...tool,activity:tool.activity||state.page,title:tool.title||(active?.id===tool.id?active.block?.title:null)};}
 const native=state.page==='reviews'?(reviewTrainingContext()||(pausedReview?.training_run_id?{training_run_id:pausedReview.training_run_id}:null)):null;
 const run=state.page==='board'?state.readingTrainingRun:workspace.get('training-plan-active')?.run;
 const id=native?.training_run_id||(state.page==='board'?readingTracker?.training_run_id:null);
 if(!id)return null;
 return {id,activity:native?'review':'reading',title:run?.id===id?run.block?.title:null,entry_id:native?.entry_id||(state.page==='board'?state.doc.id:null)};
}
function toolbarRun(context){
 const stored=workspace.get('training-plan-active')?.run;
 const initial=trainingView?.trainingRun?.id===context.id?trainingView.trainingRun:stored?.id===context.id?stored:null;
 const run=toolbarRunCache?.id===context.id&&(!initial||toolbarRunCache.revision>=initial.revision)?toolbarRunCache:initial;
 const source=trainingView?.storm||trainingView?.attempt||trainingView?.session;
 const signature=String(context.id)+':'+String(source?.id)+':'+String(source?.status??source?.finished??source?.completed);
 if(!trainingSessionBar?.busy&&!toolbarRunRequest&&(signature!==toolbarRunSource||Date.now()-toolbarRunRefresh>5000)){
  const visit=documentRequest,identity=loadedWorkspaceIdentity,panel=trainingView;
  toolbarRunSource=signature;toolbarRunRefresh=Date.now();
  const request=api('/api/training/runs/'+encodeURIComponent(context.id));toolbarRunRequest=request;
  void request.then(latest=>{
   if(visit!==documentRequest||identity!==loadedWorkspaceIdentity||panel!==trainingView||toolbarRunRequest!==request)return;
   toolbarRunCache=latest;
  }).catch(()=>{}).finally(()=>{if(toolbarRunRequest===request)toolbarRunRequest=null;});
 }
 return run||{id:context.id,activity:context.activity,state:'active',block:{title:context.title},duration_ms:null};
}
function trainingToolbarContext(){
 const program=programSessionContext();
 if(isNativeTraining(state.page)){
  const run=program?toolbarRun(program):null;
  const native=nativeToolbarState(trainingView,{activity:state.page,run});
  if(!native)return null;
  if(!program)return {...native,title:t(native.title),program:false,canFinish:false};
  const projected=programToolbarState(run,{elapsedMs:toolbarProgress.elapsed(run,native),active:native.active,paused:native.paused,canPause:native.canPause});
  const recorded=native.measurementMs==null||native.clockLabel==='Temps enregistré';
  return projected?{...projected,program:true,canFinish:true,clockLabel:recorded?(projected.targetMs?'Restant estimé':'Temps enregistré'):'Séance',nativeId:native.nativeId}:null;
 }
 if(state.page==='reviews'){
  const review=reviewToolbarState();if(!review)return null;
  const context={...review,clockType:review.targetMs?'countdown':'elapsed',clockLabel:review.targetMs?'Séance':'Temps effectué'};
  if(program){
   const run=toolbarRun(program);
   if(run.launch?.goal){
    const projected=programToolbarState(run,{elapsedMs:review.elapsedMs,active:review.active,paused:review.paused,canPause:review.canPause});
    if(projected)return {...context,...projected,...program,program:true,canFinish:review.canFinish,nativeId:review.id};
   }
   return {...context,...program,program:true};
  }
  return {...context,program:false};
 }
 if(state.page==='board'&&readingTracker){
  const tracker=readingTracker,reading=workspace.get('reading-toolbar');
  if(!program&&Number(reading?.entryId)!==Number(state.doc.id))return null;
  const elapsedMs=tracker.toolbarElapsedMs(),paused=tracker.paused;
  if(program){const run=state.readingTrainingRun;if(!run||run.id!==program.id)return null;
   const projected=programToolbarState(run,{elapsedMs:(tracker.toolbarBaselineMs||0)+elapsedMs,paused,canPause:true});
   return projected?{...projected,...program,program:true,canFinish:true,clockLabel:'Séance'}:null;
  }
  return {id:'reading:'+state.doc.id,activity:'reading',title:state.doc.title||t('Lecture'),program:false,elapsedMs,clockType:'elapsed',clockLabel:'Temps de lecture',paused,canPause:true,canFinish:true};
 }
 if(state.page==='board'&&analysisTimeTracker)return {id:'analysis:'+analysisTimeTracker.source.visit_id,activity:'analysis',title:state.doc.title||t('Analyse'),program:false,elapsedMs:analysisTimeTracker.toolbarElapsedMs(),clockType:'elapsed',clockLabel:'Temps actif',paused:analysisTimeTracker.paused,canPause:true,canFinish:true};
 return null;
}
function retainToolbarRun(run,{paused=false}={}){
 toolbarRunCache=run;toolbarRunRefresh=Date.now();
 const previous=workspace.get('training-plan-active');
 workspace.set('training-plan-active',{...(previous?.run?.id===run.id?previous:{}),run,toolbar_paused:paused,
  ...(run.activity==='reading'?{entry_id:state.doc.id,resume_on_board:true}:{resume_on_tool:isNativeTraining(run.activity)})});
 if(run.activity==='reading')state.readingTrainingRun=run;
 else if(trainingView?.trainingRun?.id===run.id)trainingView.trainingRun=run;
}
async function trainingToolbarAction(action,context){
 const current=trainingToolbarContext();if(!current||current.id!==context.id)return;
 if(action==='pause'||action==='resume'){
  const visit=documentRequest,identity=loadedWorkspaceIdentity;
  const stillCurrent=()=>visit===documentRequest&&identity===loadedWorkspaceIdentity;
  // A stale polling response must not undo the state of this explicit action.
  toolbarRunRequest=null;
  if(action==='pause'){
   if(context.activity==='review'){pauseReviewToolbar();persistReview();}
   else if(context.activity==='reading'){await readingTracker.pause();workspace.set('reading-toolbar',{entryId:state.doc.id,paused:true});renderReadingToolbarPause();await readingTracker.settle();}
   else if(context.activity==='analysis'){await analysisTimeTracker.pause();renderReadingToolbarPause();await analysisTimeTracker.settle();}
   else if(context.activity==='computer'){trainingView.pauseGame();await trainingView.archive?.();}
  }
  if(!stillCurrent())return;
  if(context.program){const run=await mutateTrainingRun(context.id,action,{store:workspace});if(!stillCurrent())return;retainToolbarRun(run,{paused:action==='pause'});}
  if(action==='resume'){
   if(context.activity==='review'){resumeReviewToolbar();persistReview();}
   else if(context.activity==='reading')readingTracker.resume();
   else if(context.activity==='analysis')analysisTimeTracker.resume();
   else if(context.activity==='computer'){await trainingView.resume();if(!stillCurrent())return;await trainingView.archive?.();}
  }
  if(context.activity==='reading'){workspace.set('reading-toolbar',{entryId:state.doc.id,paused:action==='pause'});renderReadingToolbarPause();}
  if(context.activity==='analysis'){renderReadingToolbarPause();persistAnalysis();}
  trainingSessionBar?.render();return;
 }
 if(context.program)return programSessionAction(action,context);
 if(context.activity==='review'){
  if(action==='finish'){await settleReviewTraining({finishing:true});pausedReview=null;workspace.remove('review');stopReview();}
  else if(!pauseCurrentReview())return;
  return navigate('reviews');
 }
 if(context.activity==='reading')return navigate('reading');
 if(context.activity==='analysis')return navigate('training-plan');
 if(context.activity==='computer'){trainingView.pauseGame();await trainingView.archive?.();}
 return navigate('exercises');
}
async function launchProgramRun(initial){
 const identity=loadedWorkspaceIdentity,request=documentRequest;
 const current=()=>identity===loadedWorkspaceIdentity&&request===documentRequest;
 let run=await api('/api/training/runs/'+encodeURIComponent(initial.id));if(!current())return false;
 if(['completed','cancelled'].includes(run.state))throw new Error(t('Ce bloc est déjà terminé. Actualise le programme avant de le relancer.'));
 if(isNativeTraining(run.activity)){
  if(!await preserveAnalysisWorkspace()||!current()||!pauseCurrentReview())return false;
  if(run.state==='paused')run=await mutateTrainingRun(run.id,'resume',{store:workspace});
  if(!current())return false;
  workspace.set('training-plan-active',{run,resume_on_tool:true});
  return navigate(run.activity,{training:true});
 }
 if(run.activity==='review'){
  const saved=snapshotReview()||pausedReview||workspace.get('review');
  if(conflictingReview(saved,run.id))throw new Error(t('Une autre révision est en cours. Reprends-la depuis Révisions avant de lancer ce bloc.'));
  if(run.state==='paused')run=await mutateTrainingRun(run.id,'resume',{store:workspace});
  if(!current())return false;
  workspace.set('training-plan-active',{run,resume_on_board:false});
  if(saved?.training_run_id===run.id&&!reviewSessionFinished(saved)){
   pausedReview={...scopedReviewSnapshot(saved,run),toolbarPaused:false,...reviewCallbacks(saved.base?.id)};return resumePausedReview({training:true});
  }
  const response=await prepareTrainingReview(run);
  if(!current())return false;
  if(!await preserveAnalysisWorkspace())throw new Error(t('La séance est prête. Termine le coup en cours pour l’ouvrir.'));
  const source=response.base||{id:null,name:run.block.title||t('Mon entraînement'),settings:{}};
  workspace.set('review',{...response,training_run_id:run.id,base:source,cards:response.cards||[],index:0,completed:response.completed||0,sessionElapsedMs:response.elapsed_ms||0,attempt:null,all:false});
  pausedReview=null;teardown();state.trainingToolbar=true;state.page='reviews';render({reviewSession:true});
  await startReview(document.getElementById('main'),source,{...reviewCallbacks(null),goal:response.goal,training_run_id:run.id,preparedSession:response});return true;
 }
 if(run.activity==='reading'){
  const target=readingLaunchTarget(await api('/api/reading'),run.launch.base_id);if(!current())return false;
  if(!await preserveAnalysisWorkspace()||!pauseCurrentReview())return false;
  if(run.state==='paused')run=await mutateTrainingRun(run.id,'resume',{store:workspace});
  if(!current())return false;
  state.readingTrainingRun=run;workspace.set('training-plan-active',{run,entry_id:target.entryId,resume_on_board:true});
  try{return await openEntry(target.entryId,{path:target.path,retainCurrent:true,training:true});}
  catch(error){state.readingTrainingRun=null;throw error;}
 }
 throw new Error(t('Cette activité se déclare depuis le programme.'));
}
async function programSessionAction(action,context){
 const identity=loadedWorkspaceIdentity,runId=context.id,visit=documentRequest,page=state.page,sourceBoard=state.board;
 const current=()=>identity===loadedWorkspaceIdentity&&visit===documentRequest&&page===state.page&&(context.activity!=='reading'||state.board===sourceBoard);
 if(context.activity==='reading'){
  const tracker=readingTracker,board=state.board,run=state.readingTrainingRun;
  if(!tracker||tracker.training_run_id!==runId)throw new Error(t('Le contexte de cette lecture a changé. Rouvre le bloc depuis le programme.'));
  await tracker.settle();if(!current())return;
  if(action==='confirm_reading'){
   const result=await mutateTrainingRun(runId,action,{store:workspace,entryId:context.entry_id});
   if(!current())return;
   state.readingTrainingRun=result;workspace.set('training-plan-active',{run:result,entry_id:context.entry_id,resume_on_board:true});notice(t('Partie étudiée enregistrée.'));return;
  }
  // Stop heartbeats before completing the episode; all accepted time is flushed.
  tracker.dispose();await flushReadingWrites();if(!current())return;
  if(tracker.failed.length){state.readingTrainingRun=run;await mountReadingTracker(board);throw new Error(t('Le suivi de lecture reste à synchroniser. Réessaie avant de terminer ce bloc.'));}
  readingTracker=null;state.readingTrainingRun=null;
  try{
   const result=await mutateTrainingRun(runId,action==='finish'?'finish':'pause',{store:workspace});if(!current())return;
   if(action==='finish')workspace.remove('training-plan-active');else workspace.set('training-plan-active',{run:result,entry_id:context.entry_id,resume_on_board:false});
  }catch(error){if(current()){state.readingTrainingRun=run;readingTracker=tracker;if(error.status>=400&&error.status<500)await mountReadingTracker(board);}throw error;}
 }else if(isNativeTraining(context.activity)){
  const panel=trainingView;
  if(nativeProgramContext(panel)?.id!==runId)throw new Error(t('Le contexte de cet entraînement a changé. Reprends le bloc depuis le programme.'));
  await settleNativeProgram(panel,action);if(!current())return;
  if(context.activity==='computer'){
   persistComputer(panel.snapshot());await computerHistory.flush();if(!current())return;
   const archive=computerHistory.info(panel.snapshot()?.session?.id);
   if(archive.pending||archive.conflict||archive.error)throw new Error(archive.error||t('La synchronisation de cette partie est en attente.'));
  }
  const result=await mutateTrainingRun(runId,action==='finish'?'finish':'pause',{store:workspace});if(!current())return;
  panel.trainingRun=result;
  if(action==='finish')workspace.remove('training-plan-active');else workspace.set('training-plan-active',{run:result,resume_on_tool:false});
 }else{
  await settleReviewTraining({finishing:action==='finish'});if(!current())return;
  const snapshot=suspendReview({assisted:false});
  if(snapshot){pausedReview={...snapshot,...reviewCallbacks(snapshot.base?.id)};persistReview(snapshot);}
  try{
   const result=await mutateTrainingRun(runId,action==='finish'?'finish':'pause',{store:workspace});if(!current())return;
   if(action==='finish'){if(workspace.get('review')?.training_run_id===runId)workspace.remove('review');pausedReview=null;workspace.remove('training-plan-active');}
   else workspace.set('training-plan-active',{run:result,resume_on_board:false});
   stopReview();
  }catch(error){if(current()&&pausedReview&&error.status>=400&&error.status<500)await resumePausedReview();throw error;}
 }
 if(current()){if(action==='finish')notice(t('Bloc terminé. Ton travail est enregistré.'));await navigate('training-plan',{view:'today'});}
}
async function startGuessFromAnalysis(){
 const board=state.board;if(!board||board.busy||board.inputLocked||editorBusy)return;
 const launch={doc:structuredClone(board.doc),path:board.path};
 if(!await preserveAnalysisWorkspace()||!pauseCurrentReview())return;
 trainingLaunch=launch;await navigate('guess');
}
async function startComputerFromAnalysis(){
 const board=state.board,request=documentRequest,identity=loadedWorkspaceIdentity;
 if(!board||board.busy||board.inputLocked||editorBusy)return;
 const launch={doc:structuredClone(analysisSaveSnapshot()),path:board.path};
 const current=()=>request===documentRequest&&identity===loadedWorkspaceIdentity&&board===state.board;
 if(!await preserveAnalysisWorkspace()||!current()||!pauseCurrentReview())return;
 if(computerSessionSnapshot(computerSnapshot))await computerHistory.archive(computerSnapshot);
 if(!current())return;computerLaunch=launch;await navigate('computer');
}
function libraryPage(){
 const bases=state.library.bases.filter(b=>state.folder===null||(b.folder_id??0)===state.folder);
 const selectedFolder=state.library.folders.find(folder=>folder.id===state.folder),hasChildren=selectedFolder&&state.library.folders.some(folder=>folder.parent_id===selectedFolder.id);
 const deleteEmpty=selectedFolder&&isFolderEmpty(selectedFolder.id,state.library.folders,state.library.bases)?'<button type="button" class="danger quiet" data-delete-empty-folder="'+selectedFolder.id+'">'+esc(t('Supprimer ce dossier vide'))+'</button>':'';
 const cards=!bases.length&&selectedFolder?empty(t(hasChildren?'Ce dossier contient des sous-dossiers':'Ce dossier est vide'),t(hasChildren?'Sélectionne un sous-dossier dans la liste pour voir ses bases.':'Crée une base ou déplace une base existante dans ses réglages.'),button(t('Créer une base'),'new-base')+deleteEmpty):!state.library.bases.length?empty(t('Ta bibliothèque commence ici'),t('Importe tes PGN dans une première base. Tes parties, cours, répertoires et positions conservent leurs annotations.'),button(t('Créer une base'),'new-base','primary')+button(t('Ajouter des exemples'),'demo')):!bases.length?empty(t('Ce dossier est vide'),t('Crée une base ou déplace une base existante dans ses réglages.'),button(t('Créer une base'),'new-base')):ui('<div class="base-grid">')+bases.map(libraryBaseCard).join('')+ui('</div>');
 return title(t('Bibliothèque'),t('Tes bases PGN, organisées comme tu le souhaites.'),button(t('Importer une grande base…'),'import-reference')+button(t('＋ Dossier'),'new-folder')+button(t('＋ Nouvelle base'),'new-base','primary'))+ui('<div id="library-content" class="library-layout">')+libraryFoldersHtml(state.library.folders,state.library.bases,state.folder,libraryFolderState)+ui('<section>')+cards+ui('</section></div>');
}
function libraryBaseCard(b){
 const folderName=folderLabel(b.folder_id)||t('Sans dossier'),uses=libraryBaseUsesTitle(b);
 return ui('<div class="base-card-item" data-library-base="')+b.id+ui('" draggable="true"><button class="base-card" data-base="')+b.id+'" data-context-name="'+esc(b.name)+ui('" aria-haspopup="menu" aria-expanded="false"><div class="base-card-head">')+baseLogoHtml(b)+ui('<span>')+b.entry_count+' '+t(b.entry_count===1?'partie / position':'parties / positions')+ui('</span></div><h2 title="')+esc(b.name)+'">'+esc(b.name)+ui('</h2><p title="')+esc(folderName)+'">'+esc(folderName)+ui('</p><div class="tags" title="')+esc((b.tags||[]).join(' · '))+'">'+(b.tags||[]).map(badge).join('')+ui('</div><div class="base-uses" title="')+esc(uses)+'">'+libraryBaseUsesHtml(b)+ui('</div></button><button type="button" class="base-drag-handle" data-library-drag="')+b.id+"\" draggable=\"false\" aria-label=\""+esc(t("Déplacer "))+esc(b.name)+ui(' · glisser ou choisir un dossier" title="Glisser pour déplacer ou réordonner · cliquer pour choisir un dossier · Alt + ↑ / ↓ pour réordonner"><span aria-hidden="true">⠿</span></button></div>');
}
function libraryBaseUsesTitle(b){
 return [b.reference?t('Référence · ')+referenceStatusLabel(b.reference_status?.status):'',...libraryModes(b).filter(mode=>mode.checked).map(mode=>mode.label+(mode.key==='review_enabled'?' · '+TYPES[b.settings.type]:mode.key==='is_repertoire'?' · '+t(b.settings.color==='black'?'Noirs':'Blancs') :''))].filter(Boolean).join(' · ');
}
function libraryBaseUsesHtml(b){
 return libraryModeBadgesHtml(b)+(b.reference?'<span class="library-reference-status">'+esc(t('Référence · ')+referenceStatusLabel(b.reference_status?.status))+'</span>':'');
}
async function toggleLibraryMode(id,key,enabled){
 const source=state.library.bases.find(base=>base.id===id),settings=libraryModeSettings(source,key,enabled);if(!settings)return;
 const identity=loadedWorkspaceIdentity;
 const updated=await api('/api/bases/'+id,{method:'PATCH',body:{settings}});
 if(identity!==loadedWorkspaceIdentity)return;
 const index=state.library.bases.findIndex(base=>base.id===id);if(index<0)return;state.library.bases[index]=updated;
 if(state.page==='library'){
  const card=document.querySelector('#library-content [data-base="'+id+'"]'),uses=card?.querySelector('.base-uses');
  if(uses){uses.innerHTML=libraryBaseUsesHtml(updated);uses.title=libraryBaseUsesTitle(updated);}
  const item=collectionView?.items.find(item=>item.nodes.some(node=>node.dataset.libraryBase===String(id)));
  if(item){item.values.usage=libraryModes(updated).filter(mode=>mode.checked).map(mode=>mode.icon);item.values.primary=updated.settings.primary?'primary':'secondary';collectionView.update();}
  if(card?.closest('[hidden]')&&libraryMenu?.anchor===card){
   libraryMenu?.close();
   document.querySelector('#library-content [data-list-search-menu]>summary')?.focus({preventScroll:true});
  }
 }
 refreshBoardMenus();void refreshUnfinishedActivities();
}
function bindLibraryMenu(){
 const root=document.getElementById('library-content');if(!root)return;
 bindLibraryFolders(root,libraryFolderState);
 libraryDrag=new LibraryDrag(root,{onMove:moveLibraryBase,onChooseFolder:moveLibraryBaseDialog});
 root.querySelector('[data-delete-empty-folder]')?.addEventListener('click',event=>void deleteFolder(Number(event.currentTarget.dataset.deleteEmptyFolder)).catch(fail));
 libraryMenu=new LibraryMenu(root,{getBase:id=>state.library.bases.find(base=>base.id===id),onToggleMode:toggleLibraryMode,onError:fail,canDeleteFolder:id=>isFolderEmpty(id,state.library.folders,state.library.bases),onAction:(type,id,action)=>{
  if(state.page!=='library')return;
  if(type==='base'){
   if(!state.library.bases.some(b=>b.id===id))return;
   state.tab='settings';return navigate('base',{baseId:id,keepTab:true}).catch(fail);
  }
  if(action==='delete')return deleteFolder(id).catch(fail);
  renameFolder(id);
 }});
}
const deletingLibraryFolders=new Set();
async function deleteFolder(id){
 const folder=state.library.folders.find(item=>item.id===id);if(!folder||deletingLibraryFolders.has(id)||!isFolderEmpty(id,state.library.folders,state.library.bases))return;
 if(!confirm(t('Supprimer le dossier vide « {name} » ?', {name:folder.name})))return;
 const identity=loadedWorkspaceIdentity;deletingLibraryFolders.add(id);
 try{
  let failure=null;try{await api('/api/folders/'+id,{method:'DELETE'});}catch(error){if(error.status!==404&&error.status!==409)throw error;failure=error;}
  if(identity!==loadedWorkspaceIdentity)return;
  await loadLibrary();if(identity!==loadedWorkspaceIdentity)return;
  if(state.folder===id&&!state.library.folders.some(item=>item.id===id))state.folder=state.library.folders.some(item=>item.id===folder.parent_id)?folder.parent_id:null;
  if(state.page==='library'){render();document.querySelector('[data-folder="'+(state.folder===null?'all':state.folder===0?'root':state.folder)+'"]')?.focus({preventScroll:true});}
  if(failure)throw failure;notice(t('Dossier vide supprimé.'));
 }finally{deletingLibraryFolders.delete(id);}
}
async function moveLibraryBase(payload){
 const focusHandle=document.activeElement?.closest?.('[data-library-drag]');
 await api('/api/library/bases/move',{method:'POST',body:payload});await loadLibrary();
 if(state.page==='library'){const restore=focusHandle&&document.activeElement===focusHandle;render();if(restore)document.querySelector('[data-library-drag="'+payload.base_id+'"]')?.focus({preventScroll:true});}notice(Object.hasOwn(payload,'folder_id')?t('Base déplacée.'):t('Ordre des bases enregistré.'));
}
function moveLibraryBaseDialog(id){
 const source=state.library.bases.find(b=>b.id===id);if(!source)return;
 return modal(t('Déplacer « ')+source.name+' »',ui('<label>Dossier de destination<select name="folder_id">')+folderOptions(source.folder_id)+ui('</select></label><p class="hint">Tu peux aussi glisser la base vers un dossier, ou entre deux bases pour changer leur ordre. Au clavier, Alt + ↑ / ↓ sur la poignée change son ordre.</p>'),{submit:t('Déplacer'),onSubmit:async form=>moveLibraryBase({base_id:id,folder_id:form.get('folder_id')?Number(form.get('folder_id')):null})});
}
function renameFolder(id){
 const folder=state.library.folders.find(f=>f.id===id);if(!folder)return;
 const dialog=modal(t('Renommer le dossier'),field(t('Nom du dossier'),'name',folder.name,'text','required maxlength="200"'),{submit:t('Renommer'),onSubmit:async form=>{
  const name=String(form.get('name')||'').trim();if(!name)throw new Error(t('Le nom du dossier ne peut pas être vide.'));
  await api('/api/folders/'+id,{method:'PATCH',body:{name}});await loadLibrary();
  if(state.page==='library')render();notice(t('Dossier renommé.'));
 }});
 dialog.querySelector('input[name=name]')?.select();
 dialog.addEventListener('close',()=>{if(state.page==='library')document.querySelector('[data-folder="'+id+'"]')?.focus({preventScroll:true});},{once:true});
}
function basePage(){const b=base();if(b.reference)return referenceBasePage(b);return title(b.name,folderLabel(b.folder_id)||t('Base PGN personnelle'),button(t('Importer PGN'),'import')+button(t('Exporter PGN'),'export')+button(t('＋ Partie / position'),'new-entry','primary'))+ui('<div class="tabs"><button data-tab="content" aria-pressed="')+(state.tab==='content')+ui('">Contenu <span id="base-entry-count">')+b.entry_count+ui('</span></button>')+(b.settings.is_repertoire?ui('<button data-tab="coverage" aria-pressed="')+(state.tab==='coverage')+ui('">À compléter</button>'):'')+ui('<button data-tab="settings" aria-pressed="')+(state.tab==='settings')+ui('">Réglages de la base</button></div>')+(state.tab==='settings'?baseSettings(b):state.tab==='coverage'?ui('<section id="repertoire-coverage" aria-label="Réponses à préparer"></section>'):readingBaseSummaryHtml(b,status.capabilities?.entry_pagination?null:state.entries)+ui('<section id="base-entry-table" aria-label="Parties et exercices de la base"></section>'));}
function currentEntryTable(table,baseId){return entryTable===table&&state.page==='base'&&state.tab==='content'&&state.baseId===baseId;}
function referenceBasePage(b){
 return title(b.name,folderLabel(b.folder_id)||t('Base de référence'),button(t('Exporter PGN'),'export-reference'))+ui('<div class="tabs"><button data-tab="content" aria-pressed="')+(state.tab==='content')+ui('">Contenu <span id="base-entry-count">')+esc(b.entry_count)+ui('</span></button><button data-tab="settings" aria-pressed="')+(state.tab==='settings')+ui('">Réglages de la base</button></div>')+(state.tab==='settings'?referenceBaseSettings(b):ui('<section id="reference-library" aria-label="Parties de la base de référence"></section>'));
}
function referenceBaseSettings(b){
 return ui('<form id="base-settings" class="settings-form"><section class="panel"><h2>Organisation</h2><div class="fields">')+field(t('Nom'),'name',b.name,'text','required')+ui('<label>Dossier<select name="folder_id">')+folderOptions(b.folder_id)+ui('</select></label>')+field(t('Catégories libres, séparées par des virgules'),'tags',(b.tags||[]).join(', '))+ui('</div><p class="reference-base-note">Cette base sert de référence à l’explorer et à la recherche de positions. Pour travailler une partie ou la réviser, ouvre-la dans l’analyse et sauvegarde une copie dans une base personnelle.</p></section>')+baseAppearanceSettingsHtml()+guessBaseSettingsHtml(b)+ui('<section class="panel"><h2>Fichier source</h2><p class="reference-base-note">')+esc(b.reference_status?.source||t('Fichier importé sur la machine hébergeant Chess Gym.'))+ui('</p><p class="hint">La sauvegarde complète inclut les parties de référence importées. Conserve aussi le fichier source pour pouvoir poursuivre une importation.</p></section><div class="actions settings-save"><button class="primary" type="submit">Enregistrer les réglages</button><button type="button" data-action="delete-base" class="danger quiet">Retirer cette base</button></div></form>');
}
function mountReferenceLibrary(){
 const source=base(),host=document.getElementById('reference-library');if(!source||!host)return;
 const panel=new ReferenceLibrary(host,{stateKey:'reference:'+source.id,base:source,getBases:()=>state.library.bases,onChanged:async()=>{await loadLibrary();},onStatus:status=>{
  if(referenceLibrary!==panel||state.page!=='base'||state.baseId!==source.id)return;
  source.reference_status=status;source.entry_count=Number(status.game_count??status.imported)||0;
  const count=document.getElementById('base-entry-count');if(count)count.textContent=source.entry_count;
 },onOpenGame:(id,{isCurrent})=>openEntry('reference:'+source.id+':'+id,{isCurrent:()=>referenceLibrary===panel&&state.page==='base'&&state.baseId===source.id&&isCurrent()})});
 referenceLibrary=panel;
}
async function reloadEntryTable(table,baseId){
 if(!currentEntryTable(table,baseId))return;
 try{
  if(table.remote){await loadLibrary();if(currentEntryTable(table,baseId)){table.base=base();await table.loadPage();}return;}
  const [library,result]=await Promise.all([api('/api/library'),api('/api/bases/'+baseId+'/entries')]);
  if(!currentEntryTable(table,baseId))return;
  state.library=library;state.entries=result.entries;
  if(!base()){await navigate('library');return;}
  table.update({entries:state.entries,base:base()});
  const count=document.getElementById('base-entry-count');if(count)count.textContent=base().entry_count;
 }catch(e){if(currentEntryTable(table,baseId))fail(new Error(t('Les modifications sont enregistrées, mais la liste n’a pas pu être actualisée. Recharge la base pour la mettre à jour. ')+e.message));}
}
async function reconcileEntryBatch(change){
 if(['delete','move','metadata'].includes(change.action))documentRequest++;
 if(['delete','move'].includes(change.action)&&state.entryNavigation?.baseId===change.source_base_id){
  if(state.entryNavigation.remote)state.entryNavigation=null;else state.entryNavigation.ids=state.entryNavigation.ids.filter(id=>!change.entry_ids.includes(id));updateEntryNavigation();
 }
 const source=state.doc;
 if(source.base_id!==change.source_base_id||!change.entry_ids.includes(source.id))return;
 if(change.action==='move'){source.base_id=change.target_base_id;return;}
 if(change.action==='review'){source.selected=change.selected;return;}
 if(change.action==='metadata')return reconcileEntryMetadata(source,change);
 if(change.action!=='delete')return;
 // A cached editor must never save back to a deleted entry. Keep its content as a free analysis.
 const visible=state.page==='board'&&state.board?.doc===source;
 const previous=visible?state.board:null,flipped=previous?.flipped,engineOn=previous?.engineOn;
 const detached=structuredClone(visible?analysisSaveSnapshot():source);
 for(const key of ['id','base_id','history','created_at','updated_at','selected'])delete detached[key];
 state.doc=detached;freeHistory.reset(detached,state.path);
 if(visible){render();state.board.flipped=flipped;state.board.renderBoard();if(engineOn)state.board.control('engine');notice(t('La partie a été supprimée de la base. Son analyse ouverte est conservée comme copie libre.'));}
}
async function reconcileEntryMetadata(source,change){
 const summary=change.updated_entries?.find(entry=>entry.id===source.id);
 if(!summary||source.updated_at&&summary.updated_at&&source.updated_at>summary.updated_at)return;
 const timeChanged=source.headers.TimeControl!==summary.headers.TimeControl;
 source.headers={...summary.headers};source.title=summary.title;source.updated_at=summary.updated_at;
 if(summary.history)source.history={...summary.history};
 // Preserve the tree, path and annotation form. A later quick-save must carry the new headers.
 source.pgn=serialize(source);
 if(timeChanged)for(const node of source.nodes)if(!/\[%emt\s/.test(node.comment||''))node.elapsed=null;
 const updatePanels=()=>{
  if(state.page!=='board'||state.board?.doc!==source)return;
  const heading=document.querySelector('#main .page-title h1');if(heading)heading.textContent=source.title||t('Partie');
  state.board.renderBoard();updateEditorToolbar();renderAnalysisNodeInfo();analysisCharts?.update();gameAnalysis?.update();repertoirePanel?.update();
  if(timeChanged)renderAnalysisMoves({follow:false,force:true});
 };
 updatePanels();
 if(!timeChanged)return;
 const fingerprint=serialize(source);
 try{
  const fresh=await api('/api/entries/'+source.id);
  if(state.doc!==source||serialize(source)!==fingerprint)return;
  // Cadence changes affect inferred thinking times, not moves or handwritten annotations.
  const nodes=new Map(fresh.nodes.map(node=>[node.path,node]));
  for(const node of source.nodes){const latest=nodes.get(node.path);if(latest?.fen===node.fen){node.clock=latest.clock;node.elapsed=latest.elapsed;}}
  updatePanels();
 }catch(e){if(state.doc===source)fail(new Error(t('Les informations PGN sont enregistrées. Rouvre la partie pour actualiser les temps des coups. ')+e.message));}
}
function mountEntryTable(){
 const baseId=state.baseId,host=document.getElementById('base-entry-table');
 const table=new EntryTable(host,{stateKey:'entries:'+baseId,entries:state.entries,base:base(),getBases:studyBases,remote:status.capabilities?.entry_pagination?{endpoint:'/api/bases/'+baseId+'/entries'}:null,
  onBatchStart:payload=>{if(payload.action==='metadata')documentRequest++;},
  onOpenEntry:id=>currentEntryTable(table,baseId)?openEntry(id,{navigation:table.navigation?.(id)||makeEntryNavigation(baseId,table.visible||state.entries,id)}):false,
  onMetadata:async id=>{
   if(!currentEntryTable(table,baseId))return;
   const request=++documentRequest,doc=await api('/api/entries/'+id);if(request!==documentRequest||table.busy||!currentEntryTable(table,baseId))return;
   const cached=state.doc,cachedPgn=serialize(cached);
   return editMetadata(doc,{onSaved:async updated=>{
    if(currentEntryTable(table,baseId)&&state.doc===cached&&cached.id===updated.id&&serialize(cached)===cachedPgn)state.doc=updated;
    await reloadEntryTable(table,baseId);
   }});
  },
  onChanged:async change=>{await reconcileEntryBatch(change);await reloadEntryTable(table,baseId);}
 });
 entryTable=table;if(table.remote)void table.loadPage();
}
function mountPlayedEntryTable(){
 const table=new EntryTable(document.getElementById('played-entry-table'),{stateKey:'played',base:{id:null,name:t('Mes parties'),settings:{}},remote:{endpoint:'/api/entries?played=true',played:true},onOpenEntry:id=>openEntry(id,{navigation:{...table.navigation(id),remote:{...table.navigation(id).remote,played:true}}}),onMetadata:async id=>{const request=++documentRequest,doc=await api('/api/entries/'+id);if(request!==documentRequest||entryTable!==table||table.disposed||state.page!=='played')return;return editMetadata(doc,{onSaved:()=>{if(entryTable===table&&state.page==='played')return table.loadPage();}});},onChanged:()=>table.loadPage()});entryTable=table;void table.loadPage();
}


function gameTable(entries,selection=false){const q=state.filter.toLocaleLowerCase();entries=entries.filter(e=>JSON.stringify([e.title,e.headers]).toLocaleLowerCase().includes(q));if(!entries.length)return empty(t('Aucune partie à afficher'),q?t('Essaie un autre terme de recherche.'):state.page==='played'?t('Ajoute ton compte ci-dessus, puis clique sur Synchroniser.'):t('Importe un fichier PGN ou sauvegarde une position dans cette base.'),state.page==='base'?button(t('Importer PGN'),'import'):button(t('Ouvrir la bibliothèque'),'library'));
return ui('<div class="table-scroll"><table class="game-table"><thead><tr>')+(selection?ui('<th title="Incluse dans les révisions">✓</th>'):'')+ui('<th>Date</th><th>Blancs</th><th>Noirs</th><th>Résultat</th><th>Cadence</th><th>Site / titre</th><th></th></tr></thead><tbody>')+entries.map(e=>{const h=e.headers||{};return ui('<tr data-entry="')+e.id+'">'+(selection?ui('<td><input type="checkbox" data-selected="')+e.id+"\" aria-label=\""+esc(t("Réviser "))+esc(e.title)+'" '+(e.selected?'checked':'')+ui('></td>'):'')+ui('<td data-label="Date">')+esc(h.Date||'—')+ui('</td><td data-label="Blancs"><strong>')+esc(h.White||'—')+ui('</strong><small>')+esc(h.WhiteElo||'')+ui('</small></td><td data-label="Noirs"><strong>')+esc(h.Black||'—')+ui('</strong><small>')+esc(h.BlackElo||'')+ui('</small></td><td data-label="Résultat">')+esc(h.Result||'*')+ui('</td><td data-label="Cadence">')+esc(h.TimeControl||'—')+ui('</td><td data-label="Site / titre"><strong>')+esc(e.title||h.Event||t('Position'))+ui('</strong><small>')+esc(h.Site||'')+ui('</small></td><td><button data-open-entry="')+e.id+"\" aria-label=\""+esc(t("Ouvrir "))+esc(e.title)+ui('">Ouvrir</button><button data-edit-metadata="')+e.id+ui('" class="quiet" title="Informations PGN" aria-label="Modifier les informations PGN">✎</button></td></tr>');}).join('')+ui('</tbody></table></div>');}
function baseSettings(b){if(b.reference)return referenceBaseSettings(b);const s={...reviewDefaults(state.preferences),...b.settings};return ui('<form id="base-settings" class="settings-form"><section class="panel"><h2>Organisation</h2><div class="fields">')+field(t('Nom'),'name',b.name,'text','required')+ui('<label>Dossier<select name="folder_id">')+folderOptions(b.folder_id)+ui('</select></label>')+field(t('Catégories libres, séparées par des virgules'),'tags',(b.tags||[]).join(', '))+ui('</div><label class="check"><input type="checkbox" name="played" ')+(s.played?'checked':'')+ui('> Afficher les parties dans « Mes parties »</label></section>')+baseAppearanceSettingsHtml()+readingSettingsHtml(b)+guessBaseSettingsHtml(b)+ui('<section class="panel"><h2>Révisions</h2><label class="check"><input type="checkbox" name="review_enabled" ')+(s.review_enabled?'checked':'')+ui('> Inclure cette base dans Révisions</label><div class="fields">')+select(t('Type d’exercice'),'type',Object.entries(TYPES),s.type||'solve')+select(t('Ordre des nouveaux exercices'),'new_order',[['pgn',t('Ordre du PGN')],['random',t('Aléatoire')]],s.new_order||'pgn')+select(t('Validation'),'mode',[['manual',t('Manuelle · comme Anki')],['automatic',t('Automatique · selon les essais')],['hybrid',t('Hybride · résultat modifiable')]],s.mode||'hybrid')+ui('</div><p class="hint">Les coups d’ouverture sont évalués individuellement. Les positions à résoudre ou à jouer ont leur propre historique.</p><div id="opening-priority-settings" ')+(s.type!=='moves'?'hidden':'')+'>'+select(t('Priorité des coups d’ouverture'),'review_priority',[['probability',t('Fréquence de rencontre')],['due',t('Ordre des échéances')]],s.review_priority||'probability')+ui('<p class="hint">La fréquence utilise la dernière exploration « À compléter » de ce répertoire. Les reprises et les anciens retards restent prioritaires. Sans statistiques, l’ordre habituel est conservé.</p></div><div id="play-settings" ')+(s.type!=='play'?'hidden':'')+ui('><div class="fields">')+select(t('Adversaire'),'engine',[['stockfish','Stockfish']],s.engine)+field(t('Force Stockfish · 0 à 20'),'skill',s.skill??10,'number','min="0" max="20"')+select(t('Camp joué'),'side',[['turn',t('Camp au trait')],['white',t('Blancs')],['black',t('Noirs')]],s.side||'turn')+select(t('Objectif'),'goal',[['win',t('Gagner la position')],['convert',t('Convertir un avantage')],['draw',t('Tenir la nulle')]],s.goal||'win')+ui('</div><p class="hint">La force 0–20 est le réglage du moteur, sans équivalence Elo annoncée. L’analyse reste à pleine force.</p></div><details><summary>Espacement des révisions</summary><p class="hint">L’espacement est adaptatif : chaque réussite allonge le délai de la carte. Les valeurs ci-dessous sont les délais minimaux, avec un plafond pour les reprises.</p><div class="fields">')+field(t('Manqué · minutes'),'again',s.again??10,'number','min="1" max="1440"')+field(t('Difficile · minimum en jours'),'hard',s.hard??2,'number','min="0.01" max="3650" step="0.01"')+field(t('Bien · minimum en jours'),'medium',s.medium??5,'number','min="0.01" max="3650" step="0.01"')+field(t('Facile · minimum en jours'),'easy',s.easy??10,'number','min="0.01" max="3650" step="0.01"')+field(t('Intervalle maximal · jours'),'max',s.max??720,'number','min="1" max="3650"')+ui('</div></details></section><section class="panel"><h2>Répertoire</h2><label class="check"><input type="checkbox" name="is_repertoire" ')+(s.is_repertoire?'checked':'')+ui('> Cette base est un répertoire d’ouvertures</label><div class="fields">')+select(t('Camp du répertoire / des coups mémorisés'),'color',[['white',t('Blancs')],['black',t('Noirs')]],s.color||'white')+ui('</div><label class="check"><input type="checkbox" name="primary" ')+(s.primary?'checked':'')+ui('> Répertoire principal pour ce camp</label><p class="hint">Un répertoire principal blanc et un noir servent de référence depuis tous les échiquiers.</p></section><div class="actions settings-save"><button class="primary" type="submit">Enregistrer les réglages</button><button type="button" data-action="delete-base" class="danger quiet">Supprimer cette base</button></div></form>');}
function reviewsPage(){
 if(!['bases','history','statistics'].includes(state.reviewView))state.reviewView='bases';
 const selected=state.reviewView;
 return ui('<header class="page-title training-header"><div class="training-header-copy"><h1>Révisions</h1><p class="muted">Mémoriser, résoudre et jouer. Chaque base possède ses propres réglages.</p></div><div class="training-header-tools">')+(unfinishedActivities().has('reviews')&&workspace.get('review')?button(t('Reprendre une séance'),'resume-stored-review'):'')+reviewAllActionsHtml(state.reviews,state.library.bases,{supported:!!status.capabilities?.daily_review_sessions})+
 ui('<div class="tabs training-tabs review-page-tabs" role="tablist" aria-label="Révisions">')+[['bases',t('Bases à réviser')],['history',t('Historique')],['statistics',t('Statistiques')]].map(([id,label])=>ui('<button type="button" role="tab" id="review-tab-')+id+'" data-review-view="'+id+'" aria-controls="review-panel-'+id+'" aria-selected="'+(selected===id)+'" tabindex="'+(selected===id?0:-1)+'">'+label+ui('</button>')).join('')+ui('</div></div></header>')+
 ui('<section role="tabpanel" id="review-panel-bases" aria-labelledby="review-tab-bases" ')+(selected!=='bases'?'hidden':'')+'>'+reviewBasesHtml()+ui('</section>')+
 ui('<section role="tabpanel" id="review-panel-statistics" aria-labelledby="review-tab-statistics" ')+(selected!=='statistics'?'hidden':'')+ui('><div id="review-statistics"></div></section>')+
 '<section role="tabpanel" id="review-panel-history" aria-labelledby="review-tab-history" '+(selected!=='history'?'hidden':'')+'><div id="review-history"></div></section>';
}
function selectReviewView(view,{focus=false}={}){
 if(state.page!=='reviews'||reviewBoard()||!['bases','statistics','history'].includes(view))return;
 if(state.reviewView!==view){state.reviewView=view;render();}
 if(focus)document.getElementById('review-tab-'+view)?.focus();
}
function bindReviewNavigation(){
 document.querySelectorAll('[data-review-all]').forEach(button=>button.onclick=()=>launchAllReviews(button.dataset.reviewAll).catch(fail));
 document.querySelectorAll('[data-review-view]').forEach(tab=>{
  tab.onclick=()=>selectReviewView(tab.dataset.reviewView,{focus:true});
  tab.onkeydown=event=>{
   if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();
   const views=['bases','history','statistics'],index=views.indexOf(tab.dataset.reviewView);
   const view=event.key==='Home'?views[0]:event.key==='End'?views.at(-1):views[(index+(event.key==='ArrowRight'?1:-1)+views.length)%views.length];
   selectReviewView(view,{focus:true});
  };
 });
}
function mountReviewStatistics(){
 const panel=new ReviewStatistics(document.getElementById('review-statistics'),{
  options:{...state.reviewStatisticsOptions},
  onOptionsChange:options=>{if(reviewStatistics===panel)state.reviewStatisticsOptions={...options};},
  onOpenBase:id=>{if(reviewStatistics===panel&&state.page==='reviews')return navigate('base',{baseId:id});},
  onReviewBase:id=>{if(reviewStatistics===panel&&state.page==='reviews'&&state.library.bases.some(base=>base.id===id&&base.settings.review_enabled))return launchReview(id);}
 });
 reviewStatistics=panel;
}
function reviewBasesHtml(){return state.reviews.length?reviewBasesTableHtml(state.reviews,state.library.bases):empty(t('Aucune base à réviser'),t('Active les révisions dans les réglages d’une base, puis sélectionne ses parties ou positions.'),button(t('Ouvrir la bibliothèque'),'library'));}
function repertoiresPage(){const bases=state.library.bases.filter(b=>b.settings.is_repertoire);return title(t('Répertoires'),t('Plusieurs ouvertures pour chaque camp, avec une principale blanche et noire.'),button(t('＋ Nouvelle base'),'new-base'))+(!bases.length?empty(t('Construis ton premier répertoire'),t('Active l’usage Répertoire dans les réglages d’une base. Les nouvelles lignes s’ajoutent depuis un échiquier compatible.'),button(t('Ouvrir la bibliothèque'),'library')):ui('<div class="base-grid">')+bases.map(b=>{const r=state.reviews.find(r=>r.base_id===b.id);return ui('<div class="panel repertoire-card"><div class="inline">')+badge(b.settings.color==='black'?t('Noirs'):t('Blancs'))+(b.settings.primary?badge(t('Principal')):'')+ui('</div><h2>')+esc(b.name)+ui('</h2><p class="muted">')+b.entry_count+t(' parties / lignes')+(r?' · '+r.total+t(' coups à apprendre · ')+r.due+t(' dus'):'')+ui('</p><div class="actions"><button data-base="')+b.id+ui('">Ouvrir</button><button data-coverage="')+b.id+ui('">À compléter</button><button data-primary="')+b.id+'" '+(b.settings.primary?'disabled':'')+ui('>Définir principal</button>')+(b.settings.review_enabled?ui('<button class="primary" data-review="')+b.id+ui('">Réviser</button><button data-learn="')+b.id+ui('">Apprendre</button>'):'')+ui('</div></div>');}).join('')+ui('</div>'));}
function mountCoverage(){
 const baseId=state.baseId;
 const panel=new RepertoireCoverage(document.getElementById('repertoire-coverage'),{baseId,onExplore:(gap,context)=>openCoverageGap(gap,{...context,baseId,panel})});
 coveragePanel=panel;
}
async function openCoverageGap(gap,{baseId,color,filters,panel,isCurrent=()=>true,validateGap,partial=false,conditionalRoot=false}){
 const board=state.board,fromAnalysis=panel===repertoirePanel&&state.page==='board',sourceId=state.doc.id,sourceBaseId=state.doc.base_id,sourcePath=state.path;
 const current=()=>!panel.disposed&&isCurrent()&&(fromAnalysis?repertoirePanel===panel&&state.page==='board'&&state.board===board&&!board.disposed&&state.doc.id===sourceId&&state.doc.base_id===sourceBaseId&&board.path===sourcePath:coveragePanel===panel&&state.page==='base'&&state.baseId===baseId);
 if(!current()||(fromAnalysis&&(!board||board.busy||board.inputLocked||editorBusy||entryNavigationBusy||resumingReview)))return false;
 let inputs=[];
 if(fromAnalysis){entryNavigationBusy=true;updateEditorToolbar();}
 try{
  if(fromAnalysis){
   captureAnnotation();persistAnalysis();
   if(!current())return false;
  }
  if(!canReplaceAnalysis())return false;
  if(fromAnalysis){board.inputLocked=true;inputs=[...(document.getElementById('annotation-form')?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled}));inputs.forEach(({input})=>input.disabled=true);}
  const request=++documentRequest;
  const doc=await api('/api/board',{method:'POST',body:{pgn:gap.pgn}});
  if(request!==documentRequest||!current())return false;
  if(validateGap&&!await validateGap())return false;
  if(request!==documentRequest||!current())return false;
  const target=doc.nodes.at(-1)?.path||'';
  doc.base_id=baseId;doc.title=t('Réponse à préparer · ')+(gap.san||t('Ouverture'));
  doc.explorer_profile={source:'lichess',ratings:filters.ratings,speeds:filters.speeds,repertoire_color:color,show_probability:true};
  teardown();state.doc=doc;state.path=target;state.page='board';state.entryNavigation=null;state.analysisTool='explorer';state.analysisMobilePanel='explorer';
  freeHistory.reset(doc,target);render();
  if(color==='black'){state.board.flipped=true;state.board.renderBoard();}
  const probability=coverageProbability(gap.probability);
  notice(probability.percent+' ('+probability.odds+') · '+(partial?t('Exploration partielle : lacune la plus probable du bilan actuel. '):'')+(conditionalRoot?t('Probabilité depuis le diagramme de départ. '):'')+t('Complète ta réponse, puis sauvegarde cette nouvelle ligne dans le répertoire.'));
  return true;
 }finally{if(fromAnalysis){entryNavigationBusy=false;board.inputLocked=false;inputs.forEach(({input,disabled})=>input.disabled=disabled);if(state.board)updateEditorToolbar();}}
}
function boardPage(){
 const tools=[['explorer',t('Explorer')],['position',t('Position')],...(state.doc.id?[['bilan',t('Bilan')]]:[]),['repertoire',t('Répertoire')]];
 if(!tools.some(([id])=>id===state.analysisTool))state.analysisTool='explorer';
 const more=button(t('Copier FEN'),'board-copy-fen','analysis-mobile-command')+button(t('Copier PGN'),'copy-pgn','analysis-mobile-command')+button(t('Retourner l’échiquier'),'board-flip','analysis-mobile-command')+button(t('Nouveau'),'reset-board')+button(t('Coller PGN / FEN'),'paste')+button(t('Éditer la position'),'edit-fen')+button(t('Jouer cette position'),'computer-current')+button(t('Deviner le coup'),'guess-current')+(state.doc.id?button(t('Enregistrer sous…'),'save-as'):'');
 const panels=[['moves',t('Coups'),'analysis-notebook'],...tools.map(([id,label])=>[id,label,'analysis-tool-'+id]),['charts',t('Graphiques'),'analysis-charts']];
 return title(state.doc.id?state.doc.title||t('Partie'):t('Analyse'),'',(pausedReview?button(t('Retour à la révision'),'resume-review'):'')+ui('<span id="analysis-entry-nav-desktop">')+entryNavigationHtml(state.entryNavigation,state.doc)+ui('</span>')+readingControlsHtml()+ui('<span class="workspace-status" id="workspace-status">Enregistré</span>')+button(state.doc.id?t('Sauvegarder'):t('Sauvegarder…'),'save-board','primary')+ui('<details class="analysis-more"><summary aria-label="Options de la partie" title="Options de la partie">⋯</summary><div class="analysis-more-actions">')+more+ui('</div></details>'))+
 ui('<div class="workbench analysis-workbench"><div class="analysis-column"><div id="board-host"></div><div id="analysis-command-dock" class="analysis-command-dock"></div></div>')+
 ui('<div class="analysis-mobile-tabs" role="tablist" aria-label="Panneau d’analyse">')+panels.map(([id,label,target])=>ui('<button type="button" id="mobile-analysis-')+id+'" role="tab" data-mobile-panel="'+id+'" aria-controls="'+target+'" aria-selected="'+(id==='moves')+'" tabindex="'+(id==='moves'?0:-1)+'">'+label+ui('</button>')).join('')+ui('</div>')+
 ui('<section id="analysis-notebook" class="analysis-notebook" aria-label="Analyse et notation de la partie"><div id="analysis-engine"></div><div id="reading-strip" class="reading-strip" hidden></div><div id="move-list" class="move-list analysis-move-list" aria-label="Coups et évaluations enregistrées, point de vue des Blancs"></div><div id="node-info"></div><details id="analysis-annotations" class="analysis-annotations"><summary>Annotations · <span id="annotation-position">Position initiale</span></summary><div id="annotation-editor"></div></details><div class="move-editor-toolbar notation-actions"><button type="button" data-action="undo" title="Annuler la dernière modification · Ctrl+Z" aria-label="Annuler la dernière modification" disabled>↶</button><button type="button" data-action="redo" title="Rétablir · Ctrl+Maj+Z" aria-label="Rétablir la modification" disabled>↷</button><button type="button" class="analysis-annotation-toggle" data-action="toggle-annotations" aria-controls="analysis-annotations" aria-expanded="false">Annotations</button><button type="button" data-action="metadata" title="Modifier les informations PGN">Infos PGN</button><button type="button" data-action="make-exercise" title="Créer un exercice depuis cette position">＋ Exercice</button>')+(state.doc.id?ui('<button type="button" data-analysis-tool="bilan" title="Analyser la partie et revoir tes erreurs">Bilan</button>'):'')+ui('<button type="button" class="move-menu-trigger" data-action="move-menu" title="Actions du coup sélectionné · clic droit sur un coup" aria-label="Actions du coup sélectionné" aria-haspopup="menu" aria-expanded="false" disabled>⋮</button></div></section>')+
 ui('<div class="analysis-tools-column"><section class="analysis-toolbox" aria-label="Outils de la partie"><div class="analysis-tool-tabs" role="tablist" aria-label="Outils de la partie">')+tools.map(([id,label])=>ui('<button type="button" role="tab" id="analysis-tab-')+id+'" data-analysis-tool="'+id+'" aria-controls="analysis-tool-'+id+'" aria-selected="'+(id===state.analysisTool)+'" tabindex="'+(id===state.analysisTool?0:-1)+'">'+label+ui('</button>')).join('')+ui('</div>')+tools.map(([id])=>ui('<div id="analysis-tool-')+id+'" class="analysis-tool-content" role="tabpanel" aria-labelledby="analysis-tab-'+id+'" '+(id!==state.analysisTool?'hidden':'')+'>'+(id==='explorer'?ui('<section id="opening-explorer" aria-label="Explorateur d’ouvertures"></section>'):id==='position'?ui('<section id="position-search" aria-label="Position dans la bibliothèque"></section>'):id==='bilan'?ui('<section id="game-analysis" aria-label="Bilan Stockfish"></section>'):ui('<section id="repertoire-panel" aria-label="Répertoires principaux"></section>'))+ui('</div>')).join('')+ui('</section><section id="analysis-charts" aria-label="Graphiques de la partie"></section></div></div>');
}
function analysisToolsVisible(){return mobileAnalysis?.active?mobileAnalysis.panel===state.analysisTool:!document.querySelector('.analysis-workbench')?.classList.contains('analysis-tools-collapsed');}
function selectAnalysisTool(id,{focus=false,fromMobile=false}={}){
 if(reportSession&&id!=='bilan')reportSession.dispose();
 const panel=document.getElementById('analysis-tool-'+id);if(!panel)return;
 if(mobileAnalysis?.active&&!fromMobile){mobileAnalysis.select(id,{focus});return;}
 state.analysisTool=id;if(!analysisToolsVisible())readingControls?.update?.({toolsCollapsed:false});explorer?.setVisible(id==='explorer'&&analysisToolsVisible());positionPanel?.setVisible(id==='position'&&analysisToolsVisible());
 document.querySelectorAll('.analysis-tool-tabs [data-analysis-tool]').forEach(tab=>{const selected=tab.dataset.analysisTool===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(focus&&selected)tab.focus({preventScroll:true});});
 document.querySelectorAll('.analysis-tool-content').forEach(item=>{item.hidden=item!==panel;});
}
function syncAnnotationToggle(){const panel=document.getElementById('analysis-annotations'),button=document.querySelector('[data-action="toggle-annotations"]');button?.setAttribute('aria-expanded',String(!!panel?.open));}
function openAnalysisAnnotations({focus=true}={}){
 if(mobileAnalysis?.active)mobileAnalysis.select('moves');
 const panel=document.getElementById('analysis-annotations');if(!panel)return;panel.open=true;syncAnnotationToggle();
 if(focus)document.querySelector('#annotation-form textarea')?.focus({preventScroll:true});
}
function updateEntryNavigation(){
 if(state.page!=='board')return;
 const position=entryNavigationState(state.entryNavigation,state.doc);
 for(const mobile of [false,true]){
  const host=document.getElementById('analysis-entry-nav-'+(mobile?'mobile':'desktop'));if(!host)continue;
  const html=entryNavigationHtml(state.entryNavigation,state.doc,{mobile})||(mobile?t('Analyse'):'');
  if(host.innerHTML!==html){host.innerHTML=html;host.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>navigateEntry(button.dataset.action==='entry-prev'?-1:1).catch(fail));}
  host.querySelectorAll('[data-action]').forEach(button=>button.disabled=editorBusy||entryNavigationBusy||resumingReview||!position||(button.dataset.action==='entry-prev'?position.previousId:position.nextId)===null);
 }
}
function ensureEntryNavigation(){
 const doc=state.doc,board=state.board,id=doc.id,baseId=doc.base_id;
 updateEntryNavigation();
 if(entryNavigationState(state.entryNavigation,doc)||!doc.id||!doc.base_id||!state.library.bases.some(b=>Number(b.id)===Number(doc.base_id)))return;
 if(entryNavigationLoad?.board===board)return;
 const loading={board};entryNavigationLoad=loading;
 const remote=status.capabilities?.entry_pagination?(state.entryNavigation?.remote||{endpoint:'/api/bases/'+baseId+'/entries',params:{sort:'added',descending:'false'}}):null;
 const params=remote?new URLSearchParams({...remote.params,around_id:String(id),limit:'50'}):null;
 api(remote?remote.endpoint+(remote.endpoint.includes('?')?'&':'?')+params:'/api/bases/'+baseId+'/entries').then(result=>{
  if(state.page!=='board'||state.board!==board||board.disposed||state.doc.id!==id||state.doc.base_id!==baseId)return;
  state.entryNavigation=remote?(result.around_found===false?null:{baseId,remote,currentId:Number(id),index:result.index,total:result.total,previousId:result.previous_id,nextId:result.next_id}):makeEntryNavigation(baseId,result.entries,id);updateEntryNavigation();persistAnalysis();
 }).catch(()=>{/* The analysis remains available if the base list cannot load. */}).finally(()=>{if(entryNavigationLoad===loading)entryNavigationLoad=null;});
}
async function navigateEntry(direction){
 const board=state.board,source=state.doc,navigation=state.entryNavigation,position=entryNavigationState(navigation,source);
 if(!board||board.disposed||board.busy||board.inputLocked||editorBusy||entryNavigationBusy||resumingReview||!position)return false;
 const id=direction<0?position.previousId:position.nextId;if(id===null)return false;
 entryNavigationBusy=true;updateEditorToolbar();
 let inputs=[];
 const sourceId=source.id,sourceBaseId=source.base_id;
 const current=()=>state.page==='board'&&state.board===board&&!board.disposed&&state.doc.id===sourceId&&state.doc.base_id===sourceBaseId;
 try{
  // Navigation preserves a recovery draft; only the Save button writes the PGN.
  captureAnnotation();persistAnalysis();
  if(!current())return false;
  board.inputLocked=true;
  inputs=[...(document.getElementById('annotation-form')?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled}));
  inputs.forEach(({input})=>input.disabled=true);
  return await openEntry(id,{navigation,isCurrent:current,training:!!state.trainingToolbar});
 }catch(error){
  if((error.status===404||error.code==='ENTRY_MOVED')&&state.entryNavigation===navigation){if(navigation.remote)state.entryNavigation=null;else navigation.ids=navigation.ids.filter(value=>value!==id);updateEntryNavigation();}
  throw error;
 }finally{
  entryNavigationBusy=false;board.inputLocked=false;inputs.forEach(({input,disabled})=>input.disabled=disabled);
  if(state.board)updateEditorToolbar();
 }
}

function bindReadingActions(){
 document.querySelectorAll('[data-reading-continue],[data-reading-bookmark]').forEach(button=>button.onclick=async()=>{
  const intent=++documentRequest;
  const bookmark=button.hasAttribute('data-reading-bookmark'),id=Number(bookmark?button.dataset.readingBookmark:button.dataset.readingContinue);
  button.disabled=true;
  try{const data=await api('/api/reading'),b=data.bases.find(b=>b.base_id===id);if(!b||intent!==documentRequest||!button.isConnected)return;
   const entry=bookmark?b.last_entry_id:b.continue_entry_id,path=bookmark?b.last_path:b.continue_path;
   if(entry)await openEntry(entry,{path:path??'',isCurrent:()=>button.isConnected&&state.page==='reading',training:!!state.trainingToolbar});
  }catch(error){fail(error);}finally{if(button.isConnected)button.disabled=false;}
 });
}
function mountStudyTracker(board){
 if(state.readingTrainingRun&&(!board.doc.id||Number(state.readingTrainingRun.launch?.base_id)!==Number(board.doc.base_id)))state.readingTrainingRun=null;
 const activity=boardStudyActivity(board.doc,state.library.bases,{analysisOnly,readingRun:!!state.readingTrainingRun});
 if(activity==='reading'){void mountReadingTracker(board);return;}
 analysisTimeTracker=new AnalysisTimeTracker({doc:board.doc,paused:analysisWorkspace?.doc===board.doc&&!!analysisWorkspace.analysisPaused,onError:()=>{if(state.board===board&&!board.disposed)notice(t('Le temps d’analyse sera réessayé à la prochaine synchronisation.'),true);}});renderReadingToolbarPause();
}
async function mountReadingTracker(board){
 if(state.readingTrainingRun&&Number(state.readingTrainingRun.launch?.base_id)!==Number(board.doc.base_id))state.readingTrainingRun=null;
 if(!board.doc.id||!state.library.bases.some(b=>Number(b.id)===Number(board.doc.base_id)&&b.settings?.reading_enabled))return;
 if(!board.doc.reading?.enabled){
  try{const summary=await api('/api/entries/'+board.doc.id+'/reading');if(state.board!==board||board.disposed)return;board.doc.reading=summary;}catch{notice(t('Le suivi de lecture n’a pas pu être chargé. Rouvre la partie pour réessayer.'),true);return;}
 }
 if(!board.doc.reading?.enabled)return;
 let run=state.readingTrainingRun;
 if(run&&Number(run.launch?.base_id)!==Number(board.doc.base_id)){state.readingTrainingRun=null;run=null;}
 if(run){
  await flushReadingWrites();if(state.board!==board||board.disposed)return;
  try{const latest=await api('/api/training/runs/'+encodeURIComponent(run.id));if(state.board!==board||board.disposed)return;if(['completed','cancelled'].includes(latest.state)){state.readingTrainingRun=null;run=null;}else{run=latest;state.readingTrainingRun=latest;const previous=workspace.get('training-plan-active');workspace.set('training-plan-active',{...(previous?.run?.id===run.id?previous:{}),run:latest,entry_id:board.doc.id,resume_on_board:true});}}
  catch(error){notice(t('Le bloc de lecture n’a pas pu être repris. Rouvre-le depuis Mon entraînement.'),true);return;}
 }
 const readingPause=workspace.get('reading-toolbar');
 const tracker=new ReadingTracker({doc:board.doc,path:board.path,training_run_id:run?.id||null,paused:run?.state==='paused'||Number(readingPause?.entryId)===Number(board.doc.id)&&!!readingPause.paused,onUpdate:reading=>{
  if(state.board!==board||board.disposed||state.doc!==board.doc||readingTracker!==tracker)return;
  state.doc.reading=reading;renderReadingStrip();renderAnalysisMoves({follow:false});
 },onError:()=>{
  if(readingTracker!==tracker)return;
  const host=document.getElementById('reading-strip');host?.classList.add('reading-error');const retry=host?.querySelector('[data-reading-retry]');if(retry)retry.hidden=false;
 }});
 tracker.toolbarBaselineMs=Math.max(0,run?.duration_ms||0);
 readingTracker=tracker;renderReadingStrip();renderReadingToolbarPause();
}
function renderReadingToolbarPause(){
 const tracker=readingTracker||analysisTimeTracker,workbench=document.querySelector('.analysis-workbench');if(!tracker||!workbench)return;
 if(!tracker.paused){
  tracker.toolbarPauseOverlay?.remove();tracker.toolbarPauseOverlay=null;
  for(const {node,inert} of tracker.toolbarPauseRegions||[])node.inert=inert;
  tracker.toolbarPauseRegions=[];return;
 }
 if(tracker.toolbarPauseOverlay)return;
 const overlay=document.createElement('div');overlay.className='training-pause-overlay';overlay.dataset.readingToolbarPause='';overlay.setAttribute('role','status');
 overlay.innerHTML='<strong>'+esc(t('Séance en pause'))+'</strong><button type="button">'+esc(t('Reprendre'))+'</button>';
 overlay.querySelector('button').onclick=()=>{const context=trainingToolbarContext();if(context)void trainingToolbarAction('resume',context).catch(fail);};
 tracker.toolbarPauseRegions=[...workbench.children].map(node=>({node,inert:!!node.inert}));
 for(const {node} of tracker.toolbarPauseRegions)node.inert=true;
 workbench.append(overlay);tracker.toolbarPauseOverlay=overlay;
}
function renderReadingStrip(){
 const host=document.getElementById('reading-strip'),tracker=readingTracker,board=state.board;if(!host)return;
 host.hidden=!tracker?.reading?.enabled;if(host.hidden)return;
 host.classList.toggle('reading-error',!!tracker.failed.length);host.innerHTML=readingStripHtml(tracker.reading);host.querySelector('[data-reading-retry]').hidden=!tracker.failed.length;
 host.querySelector('[data-reading-jump]').onclick=()=>board.go(tracker.reading.bookmark_path||'').catch(fail);
 host.querySelector('[data-reading-overview]').onclick=()=>navigate('reading').catch(fail);
 host.querySelector('[data-reading-retry]').onclick=()=>tracker.retry().then(ok=>{if(ok&&readingTracker===tracker)renderReadingStrip();});
 host.querySelector('[data-reading-next]').onclick=async()=>{
  if(tracker.continuing)return;tracker.continuing=true;
  try{await tracker.settle();const data=await api('/api/reading'),b=data.bases.find(b=>b.base_id===board.doc.base_id);
   if(state.board!==board||board.disposed)return;
   if(!b?.continue_entry_id){notice(t('La lecture de cette base est terminée.'));return;}
   if(b.continue_entry_id===board.doc.id){const line=mainlineNodes(board.doc),index=line.findIndex(n=>n.path===b.continue_path);await board.go(line[Math.min(index+1,line.length-1)]?.path||'');}
   else await openPositionEntry(b.continue_entry_id,{path:b.continue_path||'',isCurrent:()=>state.board===board&&!board.disposed});
  }catch(error){fail(error);}finally{tracker.continuing=false;}
 };
}

function markAnalysisEntrySeen(doc){
 const id=Number(doc.id);
 if(!id||doc.is_new!==true||markingEntriesSeen.has(id))return;
 markingEntriesSeen.add(id);
 // Mark only after the analysis is mounted. Metadata reads and cancelled opens
 // must leave the entry new, and this background write must not delay the board.
 api('/api/entries/'+id+'/seen',{method:'POST',body:{}}).then(result=>{
  const update=entry=>{if(Number(entry?.id)===id){entry.seen_at=result.seen_at;entry.is_new=false;}};
  update(doc);update(state.doc);state.entries.forEach(update);
  entryTable?.update({entries:state.entries});
 }).catch(()=>notice(t('Le statut « Nouveau » n’a pas pu être mis à jour. Il sera réessayé à la prochaine ouverture.'),true)).finally(()=>markingEntriesSeen.delete(id));
}
function startReportSession({finding,fingerprint,kind='retry',onResult=()=>{}}){
 reportSession?.dispose();
 const board=state.board,node=board?.doc.nodes.find(node=>node.path===(finding.before_path||''));
 if(!board||board.disposed||board.busy||board.inputLocked||editorBusy||!fingerprint||!node||node.fen!==finding.fen)return false;
 captureAnnotation();persistAnalysis();analysisResize?.disconnect();analysisResize=null;
 selectAnalysisTool('bilan');
 reportSession=new GameReportSession({board,workbench:document.querySelector('.analysis-workbench'),finding,fingerprint,kind,onResult,onClose:(session,{restore=true}={})=>{
  if(reportSession!==session)return;reportSession=null;
  if(restore&&state.board===board&&!board.disposed){analysisResize=observeAnalysisLayout(document.querySelector('.analysis-workbench'),board.host);updateEditorToolbar();}
 }});
 reportSession.ready.catch(error=>{if(reportSession)fail(error);});return true;
}
async function openReportRepertoire({report,exit}){
 reportSession?.dispose();const board=state.board;
 if(!board||board.disposed||board.busy||board.inputLocked||!exit)return false;
 const node=board.doc.nodes.find(node=>node.path===exit.path);
 if(!node||node.fen!==exit.after_fen){notice(t('La position a changé. Actualise le bilan avant de continuer.'),true);return false;}
 await board.go(exit.path);if(state.board!==board||board.disposed)return false;
 selectAnalysisTool('repertoire');
 notice(t('Compare cette position à ton répertoire. Tout ajout reste à confirmer.'));
 return true;
}
function savePositionEvaluation(board,{path,fen,line}){
 if(board!==state.board||board.disposed||board.training||board.inputLocked||editorBusy||reportSession||state.doc!==board.doc)return;
 const source=board.doc,doc=recordPositionEvaluation(source,path,fen,line,board.storedEvaluation());
 if(doc===source)return;
 captureAnnotation();
 // Keep the editor identity stable while asynchronous save dialogs are open.
 // The replaced nodes and PGN still invalidate notation and workspace snapshots.
 const previousPgn=source.pgn;Object.assign(source,doc);
 // Automatic deepening updates the current edit, without flooding Undo with engine depths.
 if(freeHistory.current)freeHistory.current=freeHistory.snapshot(source,board.path);
 gameAnalysis?.acceptEvaluationDocument?.({pgn:previousPgn});
 renderAnalysisMoves({follow:false});analysisCharts?.update();persistAnalysis();
}
function mountBoard(){
 freeHistory.record(state.doc,state.path);
 const board=state.board=new Board(document.getElementById('board-host'),{doc:state.doc,path:state.path,showClocks:true,onCopyPgn:()=>action('copy-pgn'),engineHost:document.getElementById('analysis-engine'),onBeforeNavigate:()=>captureAnnotation(),onEvaluation:savePositionEvaluation,onChange:b=>syncAnalysis(b),onVariationChange:b=>{if(b===state.board)renderAnalysisMoves({follow:false,followVariation:true});}});
 const savedWorkspace=analysisWorkspace?.doc===state.doc?analysisWorkspace:null;
 if(savedWorkspace){board.flipped=savedWorkspace.flipped;board.arrows=savedWorkspace.arrows??3;board.drawings=structuredClone(savedWorkspace.drawings||[]);board.renderBoard();}
 const workbench=document.querySelector('.analysis-workbench');
 mobileAnalysis=mountMobileAnalysis(workbench,{initial:state.analysisMobilePanel||'moves',commands:{actions:document.querySelector('.analysis-page>.page-title>.actions'),dock:document.getElementById('analysis-command-dock')},onSelect:id=>{state.analysisMobilePanel=id;if(['explorer','position','bilan','repertoire'].includes(id))selectAnalysisTool(id,{fromMobile:true});if(id==='moves')renderAnalysisMoves({follow:true});},onVisibilityChange:()=>{explorer?.setVisible(state.analysisTool==='explorer'&&analysisToolsVisible());positionPanel?.setVisible(state.analysisTool==='position'&&analysisToolsVisible());analysisResize?.refresh();}});
 readingControls=mountReadingControls(document.querySelector('.analysis-reading-controls'),{workbench,onPresetChange:({tool})=>{tool=tool==='analysis'?'bilan':tool;if(tool&&document.getElementById('analysis-tool-'+tool))selectAnalysisTool(tool);},onLayoutChange:display=>{renderAnalysisMoves({follow:false,display});analysisResize?.refresh?.();explorer?.setVisible(state.analysisTool==='explorer'&&analysisToolsVisible());positionPanel?.setVisible(state.analysisTool==='position'&&analysisToolsVisible());}});
 explorer=new OpeningExplorer(document.getElementById('opening-explorer'),{board,getBases:()=>state.library.bases,settingsOverride:state.doc.explorer_profile,visible:state.analysisTool==='explorer'&&analysisToolsVisible()});
 positionPanel=new PositionPanel(document.getElementById('position-search'),{board,visible:state.analysisTool==='position'&&analysisToolsVisible(),onOpenEntry:openPositionEntry});
 analysisCharts=new AnalysisCharts(document.getElementById('analysis-charts'),{board});const charts=analysisCharts;
 if(state.doc.id)gameAnalysis=new GameAnalysisPanel(document.getElementById('game-analysis'),{board,progressStore:reportProgress,getBases:()=>state.library.bases,onLibraryChange:loadLibrary,onOpenEntry:openEntry,onRetry:options=>startReportSession(options),onCompare:options=>startReportSession(options),onRepertoire:openReportRepertoire,onReport:data=>{if(state.board!==board||board.disposed)return;analysisReport=data;board.setAnalysisReport?.(data);charts.updateReport(data);renderAnalysisMoves({follow:false});}});
 const primaryPanel=new RepertoirePanel(document.getElementById('repertoire-panel'),{board,getBases:()=>state.library.bases,onLibraryChange:loadLibrary,onExploreGap:(gap,context)=>openCoverageGap(gap,{...context,panel:primaryPanel}),onOpenTransposition:(target,{isCurrent})=>openEntry(target.entry_id,{path:target.path,retainCurrent:true,isCurrent,validateDocument:doc=>validateTranspositionDocument(doc,target)}),onOpenCoverage:async baseId=>{if(repertoirePanel!==primaryPanel||primaryPanel.disposed)return false;state.tab='coverage';return navigate('base',{baseId,keepTab:true});}});
 repertoirePanel=primaryPanel;
 if(mobileAnalysis?.active)mobileAnalysis.select(mobileAnalysis.panel);
 explorer?.setVisible(state.analysisTool==='explorer'&&analysisToolsVisible());positionPanel?.setVisible(state.analysisTool==='position'&&analysisToolsVisible());
 moveMenu=new MoveMenu(document.getElementById('move-list'),{getDoc:()=>state.doc,canBookmark:path=>!!readingTracker?.reading?.enabled&&!!savedReadingNode(state.doc,path),onAction:(action,path)=>editTree(action,path).catch(fail)});
 document.querySelectorAll('[data-analysis-tool]').forEach(tab=>{tab.onclick=()=>selectAnalysisTool(tab.dataset.analysisTool);});
 const tabs=document.querySelector('.analysis-tool-tabs');tabs?.addEventListener('keydown',event=>{if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const items=[...tabs.querySelectorAll('[role="tab"]')],index=items.indexOf(event.target);if(index<0)return;event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;selectAnalysisTool(items[next].dataset.analysisTool,{focus:true});});
 document.getElementById('analysis-annotations')?.addEventListener('toggle',syncAnnotationToggle);
 analysisResize=observeAnalysisLayout(workbench,board.host);
 mountStudyTracker(board);
 renderBoardPanels();
 markAnalysisEntrySeen(board.doc);
 ensureEntryNavigation();
 if(savedWorkspace?.engineOn)board.control('engine');
 persistAnalysis();
}
function renderAnalysisMoves({follow=true,followVariation=false,force=false,display=readingControls?.state??displayPreferences.getMoveDisplayPreferences()}={}){
 const b=state.board,list=document.getElementById('move-list');if(!b||!list)return;
 const previousScroll=list.scrollTop,active=document.activeElement,focusedPath=active&&list.contains(active)?active.closest?.('.move[data-path]')?.dataset.path:null;
 const variation=b.selectedVariation?.();
 list.setAttribute('aria-label',display.evaluationMode==='loss'?t('Coups et pertes d’évaluation, point de vue du joueur'):t('Coups et évaluations enregistrées, point de vue des Blancs'));
 const {changed,buttons:moves}=renderAnalysisMovesInto(list,b.doc,b.path,analysisReport,variation?.path,readingTracker?.reading,{force,display});
 if(changed){moveMenu?.cancelPress();list.scrollTop=previousScroll;
  moves.forEach(el=>{el.onclick=()=>{if(b===state.board&&!b.disposed)b.go(el.dataset.path);};el.setAttribute('aria-haspopup','menu');el.setAttribute('aria-keyshortcuts','Shift+F10 ArrowLeft ArrowRight ArrowUp ArrowDown');});
 }
 if(moveMenu?.menu){const anchor=moves.find(el=>el.dataset.path===moveMenu.selectedPath);if(anchor){moveMenu.anchor=anchor;anchor.classList.add('menu-target');anchor.setAttribute('aria-expanded','true');}else moveMenu.close();}
 if(focusedPath!=null)moves.find(el=>el.dataset.path===focusedPath)?.focus({preventScroll:true});
 if(followVariation&&variation)followAnalysisMove(list,moves.find(el=>el.dataset.path===variation.path));
 else if(follow){if(b.path==='')list.scrollTop=0;else followAnalysisMove(list,moves.find(el=>el.dataset.path===b.path));}
}
function syncAnalysis(board,{record=true}={}){const contentChanged=state.doc!==board.doc;if(contentChanged)drafts.advance(state.doc,board.doc);state.doc=board.doc;state.path=board.path;readingTracker?.visit(board.doc,board.path);if(record){if(contentChanged||freeHistory.current?.doc.pgn!==board.doc.pgn)freeHistory.record(board.doc,board.path);else if(freeHistory.current)freeHistory.current.path=board.path;}renderBoardPanels();positionPanel?.update();explorer?.update();analysisCharts?.update();gameAnalysis?.update();repertoirePanel?.update();persistAnalysis();}
function editorFlags(){return freeHistory.flags();}
function updateEditorToolbar(){updateWorkspaceStatus();const flags=editorFlags(),locked=editorBusy||entryNavigationBusy;
 for(const action of ['undo','redo']){const button=document.querySelector('[data-action="'+action+'"]');if(button)button.disabled=locked||!flags['can_'+action];}
 const more=document.querySelector('[data-action="move-menu"]');if(more)more.disabled=locked||!state.path;
 for(const action of ['save-board','save-as']){const button=document.querySelector('[data-action="'+action+'"]');if(button)button.disabled=locked;}
 const resume=document.querySelector('[data-action="resume-review"]');if(resume){resume.disabled=locked||resumingReview;resume.textContent=resumingReview?t('Reprise…'):t('Retour à la révision');resume.title=t('Reprendre la séance en cours. Les modifications restent en brouillon tant que tu ne sauvegardes pas.');}
 repertoirePanel?.render();
 updateEntryNavigation();
}
async function applyAnalysisDocument(doc,path,{record=true}={}){
 const board=state.board;if(!board)return;const locked=board.inputLocked;board.inputLocked=true;
 try{drafts.advance(board.doc,doc);await board.setDoc(doc,path);if(board!==state.board||board.disposed)return;syncAnalysis(board,{record});const heading=document.querySelector('#main .page-title h1');if(heading)heading.textContent=doc.id?doc.title||t('Partie'):t('Analyse');}
 finally{if(!locked){board.inputLocked=false;if(board===state.board&&!board.disposed)board.flushEngineUpdate?.();}}
}
async function editTree(action,path){
 const board=state.board;if(!board||editorBusy||board.busy||board.inputLocked)return;
 if(action==='bookmark'){
  editorBusy=true;board.inputLocked=true;updateEditorToolbar();
  try{if(await readingTracker?.bookmark(path))notice(t('Signet déplacé.'));}
  finally{editorBusy=false;board.inputLocked=false;if(board===state.board){board.flushEngineUpdate?.();updateEditorToolbar();}}
  return;
 }
 if(action==='annotate'){await board.go(path);if(board===state.board&&!board.disposed)openAnalysisAnnotations();return;}
 editorBusy=true;board.inputLocked=true;updateEditorToolbar();
 try{const snapshot=analysisSaveSnapshot();
  const result=await api('/api/board/tree',{method:'POST',body:{pgn:serialize(snapshot),path,action,start_path:board.doc.start_path||''}});
  if(board!==state.board||board.disposed)return;
  const doc={...board.doc,...result.doc,analysis_dirty:board.doc.analysis_dirty||result.changed!==false||snapshot!==board.doc};drafts.acknowledge(board.doc,snapshot);annotationContext=null;
  await applyAnalysisDocument(doc,result.path);
  if(result.changed!==false)notice(action==='delete'?t('Continuation supprimée. Tu peux l’annuler.'):t('Variante réorganisée.'));
 }finally{editorBusy=false;board.inputLocked=false;if(board===state.board){board.flushEngineUpdate?.();board.renderBoard();}if(state.board)updateEditorToolbar();}
}
async function editHistory(direction){
 const board=state.board;if(!board||editorBusy||board.busy||board.inputLocked||!editorFlags()['can_'+direction])return;
 editorBusy=true;board.inputLocked=true;moveMenu?.close();updateEditorToolbar();
 try{const result=freeHistory.take(direction);
  if(!result||board!==state.board||board.disposed)return;const doc=result.doc;
  await applyAnalysisDocument(doc,result.path,{record:false});if(!hasAnalysisDraft(doc))workspace.remove('document:'+documentKey(doc));notice(direction==='undo'?t('Modification annulée.'):t('Modification rétablie.'));
 }finally{editorBusy=false;board.inputLocked=false;if(board===state.board){board.flushEngineUpdate?.();board.renderBoard();}if(state.board)updateEditorToolbar();}
}
function renderAnalysisNodeInfo(){const n=state.board?.node();if(!n)return;document.getElementById('node-info').innerHTML=ui('<div class="node-meta"><span class="current-san">')+esc(n.san||t('Position initiale'))+ui('</span><span>Pendule : ')+time(n.clock)+ui('</span><span>Temps du coup : ')+time(n.elapsed)+ui('</span></div>');}
function renderBoardPanels(){const b=state.board;if(!b)return;moveMenu?.close();captureAnnotation();const n=b.node(),draft=drafts.get(b.doc,n.path);renderAnalysisMoves();renderAnalysisNodeInfo();
 const parent=b.doc.nodes.find(node=>node.path===n.parent),position=document.getElementById('annotation-position');if(position)position.textContent=n.san&&parent?parent.fen.split(' ')[5]+(parent.fen.split(' ')[1]==='b'?'… ':'. ')+n.san:t('Position initiale');
 document.getElementById('annotation-editor').innerHTML=ui('<form id="annotation-form"><textarea name="comment" rows="3" aria-label="Commentaire du coup ou de la position" placeholder="Idée, plan, variante…">')+esc(draft?.comment??visibleComment(n))+ui('</textarea><div class="nag-grid">')+[[1,'!'],[2,'?'],[3,'!!'],[4,'??'],[5,'!?'],[6,'?!'],[10,'='],[14,'+/='],[15,'=/+'],[16,'+/-'],[17,'-/+'],[18,'+-'],[19,'-+']].map(([id,label])=>ui('<label><input type="checkbox" name="nag" value="')+id+'" '+((draft?.nags||n.nags||[]).includes(id)?'checked':'')+ui('><span>')+label+ui('</span></label>')).join('')+ui('</div><button type="submit">Appliquer l’annotation</button><small class="hint">La partie reste inchangée dans la base jusqu’à Sauvegarder.</small></form>');
 annotationContext={doc:b.doc,path:n.path};const annotationForm=document.getElementById('annotation-form');annotationForm.oninput=annotationForm.onchange=()=>{captureAnnotation();persistAnalysis();};
 updateEditorToolbar();document.getElementById('annotation-form').onsubmit=async e=>{e.preventDefault();if(editorBusy||b.busy||b.inputLocked)return;const snapshot=analysisSaveSnapshot();if(snapshot===b.doc)return;editorBusy=true;b.inputLocked=true;updateEditorToolbar();try{snapshot.analysis_dirty=true;snapshot.pgn=serialize(snapshot);drafts.acknowledge(b.doc,snapshot);annotationContext=null;await applyAnalysisDocument(snapshot,b.path);notice(t('Annotation appliquée au brouillon. Sauvegarde la partie pour la conserver dans la base.'));}catch(err){fail(err);}finally{editorBusy=false;b.inputLocked=false;if(b===state.board){b.flushEngineUpdate?.();b.renderBoard();}if(state.board)updateEditorToolbar();}};
}
function hasUnsavedAnalysis(){const d=state.doc;return d.id?!!d.analysis_dirty||drafts.has(d):d.nodes.length>1||d.nodes[0].fen!==START||d.nodes.some(n=>n.comment||(n.nags||[]).length);}
function canReplaceAnalysis(){captureAnnotation();persistAnalysis();return !!state.doc.id||!hasUnsavedAnalysis()||confirm(t('Cette analyse n’est pas sauvegardée. La remplacer ?'));}
async function openEntry(id,{path,fen,isCurrent=()=>true,beforeNavigate,navigation,retainCurrent=false,view=null,validateDocument=null,training=false}={}){
 if(!(retainCurrent?await preserveAnalysisWorkspace():canReplaceAnalysis())||!isCurrent())return false;
 const reference=String(id).match(/^reference:([1-9]\d*):([1-9]\d*)$/);
 const intent=++documentRequest;
 await readingTracker?.settle();await analysisTimeTracker?.settle();await flushReadingWrites();await flushAnalysisWrites();
 if(intent!==documentRequest||!isCurrent())return false;
 const request=++documentRequest;let doc=await api(reference?'/api/reference-bases/'+reference[1]+'/games/'+reference[2]:'/api/entries/'+id),resumedDraft=false;
 if(request!==documentRequest||!isCurrent())return false;
 if(reference){delete doc.id;delete doc.base_id;delete doc.history;navigation=null;}else{
  prepareSavedAnalysis(doc);const retained=analysisSnapshot(workspace,'document:entry:'+doc.id);
  if(retained?.doc?.id===doc.id&&hasAnalysisDraft(retained.doc)){
   const fresh=doc;doc={...retained.doc,base_id:fresh.base_id,reading:fresh.reading};resumedDraft=true;
   doc.analysis_source_line=doc.revision===fresh.revision?fresh.analysis_source_line:[];
   if(doc.revision!==fresh.revision){doc.analysis_dirty=true;notice(t('La partie a changé dans la base. Ton brouillon est conservé; enregistre une copie ou recharge la partie avant de modifier la version de la base.'),true);}
  }
 }
 if(view&&retainCurrent&&navigation&&!navigation.remote?.played&&Number(navigation.baseId)!==Number(doc.base_id))navigation=null;
 if(navigation&&!navigation.remote?.played&&Number(navigation.baseId)!==Number(doc.base_id)){const error=new Error(t('Cette partie a été déplacée. Rouvre sa base pour actualiser la liste.'));error.code='ENTRY_MOVED';throw error;}
 const context=navigation!==undefined?navigation:(!state.entryNavigation?.remote?.played&&Number(state.entryNavigation?.baseId)===Number(doc.base_id)?state.entryNavigation:null);
 const storedStart=doc.nodes.some(n=>n.path===(doc.start_path||''))?doc.start_path||'':'';
 let target=path==null?storedStart:path;
 const matchesFen=n=>!fen||(reference?n.fen.split(' ').slice(0,4).join(' ')===fen.split(' ').slice(0,4).join(' '):n.fen===fen);
 if(!doc.nodes.some(n=>n.path===target&&matchesFen(n)))target=(fen?doc.nodes.find(matchesFen)?.path:undefined)??storedStart;
 const positionChanged=!!fen&&!doc.nodes.some(n=>n.path===target&&matchesFen(n));
 validateDocument?.(doc);
 freeHistory.reset(doc,target);
 const readingToolbar=workspace.get('reading-toolbar');
 if(state.page==='reading'||state.readingTrainingRun)analysisOnly=false;
 if(state.page==='reading'||state.page==='board'&&Number(readingToolbar?.entryId)===Number(state.doc.id))workspace.set('reading-toolbar',{entryId:doc.id,paused:false});
 else if(readingToolbar&&!state.readingTrainingRun)workspace.remove('reading-toolbar');
 if(view){analysisOnly=view.studyActivity==='analysis';analysisWorkspace={...view,doc};state.analysisTool=view.analysisTool||'explorer';state.analysisMobilePanel=view.analysisMobilePanel||'moves';}
 if(beforeNavigate){
  // The source is already loaded; mount it before any further library refresh.
  beforeNavigate();teardown();state.trainingToolbar=training;state.entryNavigation=context?.remote?{...context,currentId:Number(doc.id),index:context.currentId===Number(doc.id)?context.index:undefined}:entryNavigationState(context,doc)?context:null;state.doc=doc;state.path=target;state.page='board';state.tab='content';state.filter='';render();
 }else{state.entryNavigation=context?.remote?{...context,currentId:Number(doc.id),index:context.currentId===Number(doc.id)?context.index:undefined}:entryNavigationState(context,doc)?context:null;state.doc=doc;state.path=target;await navigate('board',{training});}
 if(positionChanged)notice(t('La position de cet exercice a changé. La partie complète est ouverte à son point de départ.'));
 if(resumedDraft)notice(t('Brouillon repris. La partie dans la base reste inchangée jusqu’à Sauvegarder.'));
 return true;
}
async function openPositionEntry(id,{path,fen,isCurrent=()=>true}={}){
 const board=state.board,sourceId=state.doc.id,sourceBaseId=state.doc.base_id,sourcePath=state.path;
 if(!board||board.disposed||board.busy||board.inputLocked||editorBusy||entryNavigationBusy||resumingReview||!isCurrent())return false;
 const current=()=>state.page==='board'&&state.board===board&&!board.disposed&&state.doc.id===sourceId&&state.doc.base_id===sourceBaseId&&board.path===sourcePath&&isCurrent();
 let inputs=[];entryNavigationBusy=true;updateEditorToolbar();
 try{
  captureAnnotation();persistAnalysis();
  if(!current())return false;
  board.inputLocked=true;
  inputs=[...(document.getElementById('annotation-form')?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled}));
  inputs.forEach(({input})=>input.disabled=true);
  return await openEntry(id,{path,fen,isCurrent:current,beforeNavigate:()=>{},training:!!state.trainingToolbar});
 }finally{
  entryNavigationBusy=false;board.inputLocked=false;inputs.forEach(({input,disabled})=>input.disabled=disabled);if(state.board)updateEditorToolbar();
 }
}
async function openReviewEntry(card){
 if(!Number.isInteger(Number(card.entry_id))||Number(card.entry_id)<=0)throw new Error(t('La partie source de cet exercice est introuvable.'));
 const source=reviewBoard();
 return openEntry(card.entry_id,{path:card.path,fen:card.fen,isCurrent:()=>reviewBoard()===source,beforeNavigate:()=>{const snapshot=suspendReview();if(!snapshot)throw new Error(t('La séance de révision n’est plus active.'));pausedReview=snapshot;persistReview(snapshot);}});
}
async function resumePausedReview({training=!!state.trainingToolbar}={}){
 const snapshot=pausedReview,board=state.board,previousPage=state.page;
 if(!snapshot||reviewBoard()||resumingReview||editorBusy||board?.busy||board?.inputLocked)return false;
 resumingReview=true;updateEditorToolbar();
 let locked=false,inputs=[],mountedHost=null;
 try{
  // Returning never commits the edited source; review progress resumes independently.
  if(!await preserveAnalysisWorkspace())return false;
  if(pausedReview!==snapshot||state.board!==board||state.page!==previousPage)return false;
  const source=state.doc,request=documentRequest;
  reviewNavigationReady=true;
  if(board){editorBusy=true;board.inputLocked=true;locked=true;board.renderBoard();}
  inputs=[...(document.getElementById('annotation-form')?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled}));
  inputs.forEach(({input})=>input.disabled=true);updateEditorToolbar();
  // Refresh first, leaving the current page and paused session intact on failure.
  const prepared=await prepareReviewResume(snapshot);
  if(pausedReview!==snapshot||request!==documentRequest||state.board!==board||board?.disposed||state.doc!==source)return false;
  teardown();state.trainingToolbar=training;state.page='reviews';render({reviewSession:true});mountedHost=document.getElementById('main');
  if(prepared.base)Object.assign(prepared,reviewCallbacks(prepared.base.id));await resumeReview(mountedHost,prepared);
  if(pausedReview===snapshot)pausedReview=null;
  return true;
 }catch(error){
  if(mountedHost&&document.getElementById('main')===mountedHost&&state.page==='reviews'){
   stopReview();state.page=previousPage;render();
  }
  throw error;
 }finally{
  resumingReview=false;reviewNavigationReady=false;if(locked){editorBusy=false;board.inputLocked=false;}
  inputs.forEach(({input,disabled})=>input.disabled=disabled);
  if(board&&state.board===board&&!board.disposed)board.renderBoard();if(state.board)updateEditorToolbar();
 }
}
function backupSettingsHtml(){return settingsBackupHtml(status.capabilities);}
let languageSaveRequest=0;
async function changeLanguage(language){
 if(!Object.hasOwn(LANGUAGES,language)||getLanguage()===language)return;
 captureAnnotation();persistAnalysis();persistReview();
 const owner=status.username,epoch=workspace.epoch,request=++languageSaveRequest;
 setLanguage(language);state.preferences={...state.preferences,language};render();
 if(!status.capabilities?.review_preferences){notice(t('Langue conservée sur cet appareil.'));return;}
 const saving=preferencesService.patch({language},{isCurrent:()=>status.username===owner&&workspace.epoch===epoch});
 try{const prefs=await saving;if(prefs&&request===languageSaveRequest&&status.username===owner&&workspace.epoch===epoch){state.preferences={...state.preferences,...prefs};notice(t('Langue enregistrée.'));}}
 catch(error){if(request===languageSaveRequest&&status.username===owner&&workspace.epoch===epoch)fail(error);}
}
function settingsPage(){return title(t('Réglages'),t('Personnalise ChessGym et organise ton entraînement.'))+globalSettingsHtml({preferences:state.preferences,status,bases:state.library.bases,theme:document.body.dataset.theme});}
function bindPreferences(){
 const language=document.getElementById('interface-language');if(language)language.onchange=()=>changeLanguage(language.value);
 const host=document.getElementById('main'),owner=status.username,accountEpoch=workspace.epoch;
 bindSettingsTabs(host,{initialTab:setupTabRequested?'installation':null});setupTabRequested=false;
 const sameAccount=()=>status.username===owner&&workspace.epoch===accountEpoch;
 const isCurrent=()=>sameAccount()&&state.page==='settings'&&document.getElementById('main')===host;
 const onSaved=prefs=>{if(prefs&&sameAccount())state.preferences={...state.preferences,...prefs};};
 bindReviewPreferences(host,{supported:!!status.capabilities?.review_preferences,canSave:sameAccount,onSaved,isCurrent,request:(url,options)=>url==='/api/preferences'&&options?.method==='PATCH'?preferencesService.patch(options.body,{isCurrent:sameAccount}):api(url,options)});
 bindAppearanceSettings(host,{preferencesService,isCurrent,canSave:sameAccount,onSaved});
 bindTextSizeSettings(host,{preferencesService,isCurrent,canSave:sameAccount,onSaved});
 bindSoundSettings(host,{preferencesService,isCurrent,onSaved});
 bindStartupSettings(host);
 if(status.capabilities?.review_sessions)bindLearningSettings(host,{preferencesService,isCurrent,onSaved:(prefs,result)=>{onSaved(prefs);if(result)loadLibrary({force:true}).catch(fail);}});
 if(status.capabilities?.backup_automation)bindBackupSettings(host,{isCurrent});
 if(status.capabilities?.resource_settings)bindResourceSettings(host,{isCurrent});
 if(status.capabilities?.private_access_management)privateAccess=bindPrivateAccess(host,{isCurrent});
 if(status.capabilities?.app_updates)appUpdates=bindAppUpdates(host,{isCurrent,beforeRestart:async()=>{captureAnnotation();persistAnalysis();persistReview();persistComputer();await workspace.flush();await computerHistory.flush();}});
 if(status.capabilities?.setup_resources)setupResources=bindSetupResources(host,{isCurrent,onChanged:async()=>{
  const next=await api('/api/engine/status');if(!sameAccount())return;clearAnalysisCache();applyAnalysisEngine(next);status.engine=next;await engineManager?.refresh?.();await loadLibrary();
 },onComplete:async(page='library')=>{if(!sameAccount())return;status.resources_setup_required=false;await navigate(page);}});
 if(status.capabilities?.engine_management)engineManager=bindEngineManager(host,{isCurrent,onChanged:async()=>{
  const request=++engineSettingsRequest;clearAnalysisCache();const next=await api('/api/engine/status');
  if(!sameAccount()||request!==engineSettingsRequest)return;
  const changed=applyAnalysisEngine(next);status.engine=next;await setupResources?.refresh?.();
  const board=state.board;if(board&&!board.disposed){if(changed)board.engineSettingsChanged();else board.renderEngine();}
 }});
}
function bindBaseSettings(){
 const form=document.getElementById('base-settings'),source=base();let saving=false;
 baseAppearanceEditor=new BaseAppearanceEditor(document.getElementById('base-appearance-settings'),source);
 const editor=baseAppearanceEditor;
 form.querySelectorAll('[data-reading-bulk]').forEach(button=>button.onclick=async()=>{
  if(saving||editor.disposed||baseAppearanceEditor!==editor)return;
  const action=button.dataset.readingBulk;
  if(action==='unread'&&!confirm(t('Remettre la lecture de toutes les parties de cette base à zéro ? Le temps de lecture sera conservé.')))return;
  saving=true;const buttons=[...form.querySelectorAll('[data-reading-bulk]')];buttons.forEach(b=>b.disabled=true);
  try{await api('/api/bases/'+source.id+'/reading',{method:'POST',body:{action}});const result=await api('/api/bases/'+source.id+'/entries'+(status.capabilities?.entry_pagination?'?limit=50':''));if(state.page==='base'&&state.baseId===source.id)state.entries=result.entries;notice(action==='read'?t('Toutes les parties sont marquées comme lues.'):t('Toutes les parties sont marquées comme non lues.'));}
  catch(error){fail(error);}finally{saving=false;if(!editor.disposed)buttons.forEach(b=>b.disabled=false);}
 });
 if(form.elements.type)form.elements.type.onchange=()=>{document.getElementById('play-settings').hidden=form.elements.type.value!=='play';document.getElementById('opening-priority-settings').hidden=form.elements.type.value!=='moves';};
 form.onsubmit=async e=>{
  e.preventDefault();if(saving||editor.disposed||baseAppearanceEditor!==editor||state.page!=='base'||state.baseId!==source.id)return;
  let controls=[];
  try{
   const logo=editor.getPatch(),fd=new FormData(form),settings={};
   for(const k of ['review_enabled','is_repertoire','primary','played','reading_enabled','guess_enabled'])settings[k]=fd.has(k);
   for(const k of ['type','mode','engine','side','goal','color','new_order'])settings[k]=fd.get(k);
   settings.review_priority=fd.get('review_priority')||source.settings.review_priority||'probability';
   for(const k of ['again','hard','medium','easy','max','skill'])settings[k]=Number(fd.get(k));
   if(!settings.is_repertoire)settings.primary=false;
   const body={name:fd.get('name'),folder_id:fd.get('folder_id')?Number(fd.get('folder_id')):null,tags:fd.get('tags').split(',').map(x=>x.trim()).filter(Boolean)};body.settings=source.reference?{guess_enabled:settings.guess_enabled}:settings;if(logo!==undefined)body.logo=logo;
   saving=true;controls=[...form.querySelectorAll('input,select,textarea,button')].map(control=>[control,control.disabled]);editor.setDisabled(true);for(const [control] of controls)control.disabled=true;form.setAttribute('aria-busy','true');
   await api('/api/bases/'+source.id,{method:'PATCH',body});await loadLibrary();if(!source.reference&&state.page==='base'&&state.baseId===source.id)state.entries=(await api('/api/bases/'+source.id+'/entries'+(status.capabilities?.entry_pagination?'?limit=50':''))).entries;
   if(baseAppearanceEditor===editor&&!editor.disposed&&state.page==='base'&&state.baseId===source.id&&state.tab==='settings')render();notice(t('Réglages de la base enregistrés.'));
  }catch(err){fail(err);}finally{saving=false;form.removeAttribute('aria-busy');if(!editor.disposed){editor.setDisabled(false);for(const [control,disabled] of controls)control.disabled=disabled;}}
 };
}

document.addEventListener('click',event=>{document.querySelectorAll('.analysis-more[open],.analysis-reading-controls[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;document.querySelectorAll('.analysis-more[open],.analysis-reading-controls[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary')?.focus({preventScroll:true});});});
function bind(){
 document.querySelector('[data-reading-history]')?.addEventListener('click',()=>{void showReadingHistory().catch(fail);});bindReadingActions();bindMetadataButtons();document.querySelectorAll('[data-coverage]').forEach(b=>b.onclick=()=>{state.tab='coverage';navigate('base',{baseId:b.dataset.coverage,keepTab:true}).catch(fail);});document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>navigateMenu(b.dataset.page).catch(fail));document.querySelectorAll('[data-base]').forEach(b=>b.onclick=()=>navigate('base',{baseId:b.dataset.base}).catch(fail));document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});document.querySelectorAll('[data-folder]').forEach(b=>b.onclick=()=>{state.folder=b.dataset.folder==='all'?null:b.dataset.folder==='root'?0:Number(b.dataset.folder);render();document.querySelector('.library-folders [data-folder="'+b.dataset.folder+'"]')?.focus({preventScroll:true});});document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const menu=b.closest('details.analysis-more');if(menu)menu.open=false;action(b.dataset.action).catch(fail);});document.querySelectorAll('[data-open-entry]').forEach(b=>b.onclick=()=>openEntry(b.dataset.openEntry).catch(fail));document.querySelectorAll('[data-selected]').forEach(b=>b.onchange=async()=>{try{await api('/api/entries/'+b.dataset.selected,{method:'PATCH',body:{selected:b.checked}});const entry=state.entries.find(x=>x.id===Number(b.dataset.selected));if(entry)entry.selected=b.checked;}catch(e){b.checked=!b.checked;fail(e);}});document.querySelectorAll('[data-review],[data-learn]').forEach(b=>b.onclick=()=>launchReview(Number(b.dataset.review||b.dataset.learn),b.dataset.learn?'learn':'review').catch(fail));document.querySelectorAll('[data-primary]').forEach(b=>b.onclick=async()=>{try{await api('/api/bases/'+b.dataset.primary,{method:'PATCH',body:{settings:{primary:true}}});await refresh();}catch(e){fail(e);}});const search=document.getElementById('game-search');if(search)search.oninput=()=>{state.filter=search.value;document.getElementById('games').innerHTML=gameTable(state.entries,true);bindTable();};}

function bindMetadataButtons(){document.querySelectorAll('[data-edit-metadata]').forEach(b=>b.onclick=async()=>{try{const request=++documentRequest;const doc=await api('/api/entries/'+b.dataset.editMetadata);if(request!==documentRequest)return;editMetadata(doc,{onSaved:async updated=>{if(request!==documentRequest)return;if(state.doc.id===updated.id)state.doc=updated;await refresh();}});}catch(e){fail(e);}});}
function bindTable(){bindMetadataButtons();document.querySelectorAll('[data-open-entry]').forEach(b=>b.onclick=()=>openEntry(b.dataset.openEntry).catch(fail));document.querySelectorAll('[data-selected]').forEach(b=>b.onchange=async()=>{try{await api('/api/entries/'+b.dataset.selected,{method:'PATCH',body:{selected:b.checked}});const entry=state.entries.find(x=>x.id===Number(b.dataset.selected));if(entry)entry.selected=b.checked;}catch(e){fail(e);}});}
async function launchReview(id,selection='review'){
 if(reviewLaunching)return false;
 reviewLaunching=true;
 try{
  if(!await preserveAnalysisWorkspace())return false;
  pausedReview=null;teardown();state.page='reviews';render({reviewSession:true});const selected=state.library.bases.find(b=>b.id===id);workspace.remove('review');
  await startReview(document.getElementById('main'),selected,{selection,goal:{minutes:null,cards:null},...reviewCallbacks(id)});
 }catch(error){fail(error);await refresh();}finally{reviewLaunching=false;}
}
async function launchAllReviews(selection){
 if(reviewLaunching)return false;
 reviewLaunching=true;
 const identity=loadedWorkspaceIdentity;
 try{
  if(!await preserveAnalysisWorkspace())return false;
  if(identity!==loadedWorkspaceIdentity)return false;
  const response=await prepareAllReviews(selection,{store:workspace,isCurrent:()=>identity===loadedWorkspaceIdentity});
  if(identity!==loadedWorkspaceIdentity)return false;
  const base=response.base||{id:null,name:t(selection==='learn'?'Tout apprendre':'Tout réviser'),settings:{}};
  workspace.set('review',{...response,base,cards:response.cards||[],index:0,completed:response.completed||0,sessionElapsedMs:response.elapsed_ms||0,attempt:null,all:false});
  if(state.page!=='reviews')return false;
  pausedReview=null;teardown();render({reviewSession:true});
  await startReview(document.getElementById('main'),base,{...reviewCallbacks(null),goal:{minutes:null,cards:null},preparedSession:response});
 }finally{reviewLaunching=false;}
}
async function action(a){if(a==='computer-current')return startComputerFromAnalysis();if(a==='guess-current')return startGuessFromAnalysis();if(reportSession&&['save-board','save-as','undo','redo','metadata','toggle-annotations','move-menu','make-exercise'].includes(a))return;if(a==='resume-stored-review')return resumeReviewWorkspace();if(a==='export-reference')return download('/api/reference-bases/'+state.baseId+'/export');if(a==='import-reference')return referenceImportDialog({foldersHtml:folderOptions(state.folder),onCreated:async b=>{await navigate('base',{baseId:b.id});notice(t('Importation lancée. Tu peux continuer à utiliser Chess Gym.'));}});if(a==='entry-prev'||a==='entry-next')return navigateEntry(a==='entry-prev'?-1:1);if(a==='board-copy-fen'||a==='board-flip')return state.board?.control(a==='board-flip'?'flip':'copy-fen');if(a==='toggle-annotations'){const panel=document.getElementById('analysis-annotations');if(panel?.open){panel.open=false;syncAnnotationToggle();}else openAnalysisAnnotations();return;}if(a==='resume-review')return resumePausedReview();if(a==='undo'||a==='redo')return editHistory(a);if(a==='move-menu'){if(state.board&&!editorBusy&&!state.board.busy&&!state.board.inputLocked)moveMenu?.open(state.path,document.querySelector('[data-action="move-menu"]'));return;}if(a==='metadata'){const board=state.board;if(!board||editorBusy||board.busy||board.inputLocked)return;const source=state.doc,sourceContent=evaluationIndependentContent(source);return editMetadata(source,{persist:false,viewPath:state.path,onSaved:async updated=>{if(!board||board!==state.board||board.disposed||board.doc!==source||evaluationIndependentContent(board.doc)!==sourceContent)return;const current=new Map(source.nodes.map(node=>[node.path,node]));const merged={...updated,analysis_dirty:updated.analysis_dirty||source.analysis_dirty,nodes:updated.nodes.map(node=>{const latest=current.get(node.path);return latest?.fen===node.fen?{...node,comment:latest.comment}:node;})};merged.pgn=serialize(merged);await applyAnalysisDocument(merged,board.path);await loadLibrary();}});}if(a==='library')return navigate('library');if(a==='new-folder')return modal(t('Nouveau dossier'),field(t('Nom'),'name','','text','required')+ui('<label>Dossier parent<select name="parent_id">')+folderOptions(null,t('Racine'))+ui('</select></label>'),{onSubmit:async f=>{await api('/api/folders',{method:'POST',body:{name:f.get('name'),parent_id:f.get('parent_id')?Number(f.get('parent_id')):null}});await refresh();}});if(a==='new-base')return modal(t('Nouvelle base PGN'),field(t('Nom de la base'),'name','','text',ui('required placeholder="Ex. Mon Italienne"'))+ui('<label>Dossier<select name="folder_id">')+folderOptions(state.folder)+ui('</select></label>')+field(t('Catégories, séparées par des virgules'),'tags'),{submit:t('Créer la base'),onSubmit:async f=>{const b=await api('/api/bases',{method:'POST',body:{name:f.get('name'),folder_id:f.get('folder_id')?Number(f.get('folder_id')):null,tags:f.get('tags').split(',').map(x=>x.trim()).filter(Boolean)}});await navigate('base',{baseId:b.id});}});if(a==='import')return importDialog();if(a==='export')return download('/api/bases/'+state.baseId+'/export');if(a==='new-entry')return newAnalysisBoard();if(a==='paste')return pasteDialog();if(a==='reset-board')return newAnalysisBoard();if(a==='save-board')return state.doc.id?quickSave():saveDialog();if(a==='save-as')return saveDialog({copy:true});if(a==='make-exercise')return exerciseDialog();if(a==='copy-pgn'){const pgn=serialize(analysisSaveSnapshot());try{await navigator.clipboard.writeText(pgn);notice(t('PGN copié.'));}catch{modal('PGN',ui('<textarea rows="12" readonly>')+esc(pgn)+ui('</textarea>'));}return;}if(a==='edit-fen')return fenEditor();if(a==='backup-personal'){if(!status.capabilities?.personal_backup){notice(t('La sauvegarde personnelle nécessite la mise à jour du serveur.'),true);return;}return download('/api/backup?mode=personal');}if(a==='backup-full'||a==='backup'){if(!confirm(t('Créer et télécharger la sauvegarde complète, y compris toutes les grandes bases de référence ? Elle peut représenter plusieurs dizaines de Go et prendre longtemps.')))return;return download(status.capabilities?.personal_backup?'/api/backup?mode=full':'/api/backup');}if(a==='demo'){if(!confirm(t('Ajouter les bases d’exemples à ta bibliothèque ?')))return;await api('/api/demo',{method:'POST',body:{}});await refresh();notice(t('Exemples ajoutés.'));return;}if(a==='delete-base'){const b=base();if(!confirm(b.reference?t('Retirer la base de référence « ')+b.name+t(' » de la bibliothèque ? Le fichier PGN original est conservé.'):t('Supprimer « ')+b.name+' », ses '+b.entry_count+t(' parties et son historique de révision ? Cette action est définitive.')))return;await api('/api/bases/'+b.id,{method:'DELETE'});return navigate('library');}}
function importDialog(){const b=base();const d=modal(t('Importer dans ')+b.name,ui('<label>Fichier PGN<input type="file" id="pgn-file" accept=".pgn,.txt"></label><label>Ou colle un PGN contenant une ou plusieurs parties<textarea name="pgn" rows="12" required placeholder="[Event &quot;…&quot;]&#10;…"></textarea></label><p class="hint">Les commentaires, variantes et annotations sont conservés. Les doublons exacts sont signalés.</p>'),{wide:true,submit:t('Importer'),onSubmit:async f=>{const r=await api('/api/bases/'+b.id+'/import',{method:'POST',body:{pgn:f.get('pgn')}});await refresh();notice(r.imported+t(' partie(s) importée(s) · ')+r.duplicates+' doublon(s).');if(r.warnings?.length)notice(r.warnings.join(' '),true);}});d.querySelector('#pgn-file').onchange=async e=>{const file=e.target.files[0];if(file)d.querySelector('[name=pgn]').value=await file.text();};}
function pasteDialog(){return modal(t('Ouvrir un PGN ou une position FEN'),ui('<label>PGN ou FEN<textarea name="source" rows="10" required spellcheck="false"></textarea></label><p class="hint">Le PGN ouvre une partie avec ses variantes. Le FEN ouvre une position.</p>'),{wide:true,submit:t('Ouvrir'),onSubmit:async f=>{const value=f.get('source').trim();if(!canReplaceAnalysis())return;const request=++documentRequest,source=state.doc,page=state.page;const opened=await api('/api/board',{method:'POST',body:value.includes('/')&&!value.startsWith('[')&&!value.includes('\n')?{fen:value}:{pgn:value}});if(request!==documentRequest||source!==state.doc||page!==state.page)return;state.doc=opened;state.path='';freeHistory.reset(state.doc,state.path);render();}});}
// Include the visible annotation draft without changing the live document before success.
function analysisSaveSnapshot(){captureAnnotation();const result=drafts.overlay(state.doc);if(result!==state.doc)result.pgn=serialize(result);return result;}
async function quickSave(){
 const board=state.board,source=state.doc,path=state.path;
 if(!board||!source.id||editorBusy||board.busy||board.inputLocked)return;
 const snapshot=analysisSaveSnapshot(),pgn=serialize(snapshot),form=document.getElementById('annotation-form');
 const inputs=[...(form?.querySelectorAll('textarea,input,button')||[])].map(input=>({input,disabled:input.disabled}));
 editorBusy=true;board.inputLocked=true;inputs.forEach(({input})=>input.disabled=true);updateEditorToolbar();
 try{
  let saved=await api('/api/entries/'+source.id,{method:'PATCH',body:{title:source.title,pgn,start_path:source.start_path||'',view_path:path,explicit_save:true,...expectedRevision(source)}});
  if(board!==state.board||board.disposed||state.doc!==source)return;
  saved=savedAnalysisEvaluations(saved,source,board);drafts.acknowledge(source,saved);if(!drafts.has(source))workspace.remove('document:'+documentKey(source));annotationContext=null;freeHistory.reset(saved,path);await applyAnalysisDocument(saved,path,{record:false});persistAnalysis();notice(t('Modifications sauvegardées dans la base.'));
 }finally{
  editorBusy=false;board.inputLocked=false;inputs.forEach(({input,disabled})=>input.disabled=disabled);
  if(board===state.board&&!board.disposed){board.flushEngineUpdate?.();board.renderBoard();}if(state.board)updateEditorToolbar();
 }
}
function saveDialog({copy=false}={}){
 if(editorBusy||state.board?.busy||state.board?.inputLocked)return;
 if(!studyBases().length){notice(t('Crée une base personnelle pour y sauvegarder cette analyse.'));return action('new-base');}
 const current=state.doc,board=state.board,path=state.path;
 return modal(copy?t('Enregistrer sous…'):t('Sauvegarder la partie'),ui('<label>Base<select name="base_id">')+baseOptions(current.base_id||(base()?.reference?null:state.baseId)||studyBases()[0].id)+ui('</select></label>')+field(t('Titre'),'title',current.title||[current.headers.White,current.headers.Black].filter(Boolean).join(' — ')||t('Analyse'),'text','required')+(copy?ui('<p class="hint">Une nouvelle copie sera créée dans la base choisie.</p>'):''),{submit:copy?t('Créer la copie'):t('Sauvegarder'),onSubmit:async f=>{
  if(board!==state.board||state.doc!==current)throw new Error(t('La partie ouverte a changé. Rouvre la sauvegarde depuis cette partie.'));
  const snapshot=analysisSaveSnapshot(),pgn=serialize(snapshot);
  let saved=await api('/api/entries',{method:'POST',body:{base_id:Number(f.get('base_id')),title:f.get('title'),pgn,start_path:current.id?current.start_path||'':path,explicit_save:true}});
  if(board!==state.board||state.doc!==current)return;
  await loadLibrary();if(board!==state.board||state.doc!==current)return;saved=savedAnalysisEvaluations(saved,current,board);drafts.acknowledge(current,saved);if(!drafts.has(current))workspace.remove('document:'+documentKey(current));annotationContext=null;state.doc=saved;state.path=path;freeHistory.reset(saved,path);render();persistAnalysis();notice(copy?t('Copie sauvegardée dans la base.'):t('Partie sauvegardée dans la base.'));
 }});
}
function exerciseDialog(){const board=state.board;if(!board||board.disposed||board.busy||board.inputLocked||editorBusy)return;moveMenu?.close();return openExerciseEditor({sourceDoc:board.doc,sourcePath:board.path,flipped:board.flipped,bases:studyBases(),baseId:base()?.reference?null:state.baseId,onCreated:async()=>{await loadLibrary();notice(t('Exercice ajouté à la base. Ton analyse est conservée.'));}});}
function showEngineWorkspace(doc,path=''){
 const copy=structuredClone(doc);delete copy.id;delete copy.base_id;
 const d=document.createElement('dialog');d.className='wide analysis-dialog';d.innerHTML=ui('<div class="dialog-form"><div class="dialog-head"><h2>Moteur · échiquier d’analyse</h2><button type="button" data-close aria-label="Fermer">×</button></div><div class="engine-workspace"></div><section class="workspace-repertoire"></section><div class="dialog-actions"><button type="button" data-close>Fermer</button><button type="button" class="primary" data-open-analysis>Ouvrir dans l’analyse</button></div></div>');document.body.append(d);d.showModal();
 let repertoire;const board=new Board(d.querySelector('.engine-workspace'),{doc:copy,path,onChange:()=>repertoire?.update()});repertoire=new RepertoirePanel(d.querySelector('.workspace-repertoire'),{board,getBases:()=>state.library.bases,onLibraryChange:loadLibrary});board.control('engine');
 d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());
 const workspacePage=state.page,workspaceRequest=documentRequest;d.querySelector('[data-open-analysis]').onclick=()=>{if(workspacePage!==state.page||workspaceRequest!==documentRequest||board.disposed||!canReplaceAnalysis())return;state.doc=board.doc;state.path=board.path;freeHistory.reset(state.doc,state.path);d.close();navigate('board');};
 d.addEventListener('close',()=>{repertoire.dispose();board.dispose();d.remove();},{once:true});return board;
}

function fenEditor(){let boardPieces=pieces(state.board.node().fen),paint='K';const f=state.board.node().fen.split(' ');const d=modal(t('Éditer une position'),ui('<div class="fen-editor"><div id="edit-board" class="chess-board"></div><div><div class="piece-palette">')+['K','Q','R','B','N','P','k','q','r','b','n','p',''].map(c=>ui('<button type="button" data-paint="')+c+ui('" title="')+(c||t('Effacer'))+'">'+(c?ui('<img src="')+pieceUrl(c)+'" alt="'+c+'">':'×')+ui('</button>')).join('')+ui('</div><div class="fields">')+select(t('Trait'),'turn',[['w',t('Blancs')],['b',t('Noirs')]],f[1])+field(t('Droits de roque'),'castling',f[2],'text','pattern="-|K?Q?k?q?"')+field(t('Case en passant'),'ep',f[3])+field(t('Numéro du coup'),'fullmove',f[5],'number','min="1"')+ui('</div><div class="actions"><button type="button" id="clear-position">Vider</button><button type="button" id="start-position">Position initiale</button></div><p class="hint">Choisis une pièce puis touche une case. Le serveur vérifie la légalité de la position.</p></div></div>'),{wide:true,submit:t('Utiliser cette position'),onSubmit:async fd=>{let rows=[];for(let rank=8;rank>=1;rank--){let str='',empty=0;for(const file of 'abcdefgh'){const p=boardPieces[file+rank];if(p){if(empty){str+=empty;empty=0;}str+=p;}else empty++;}if(empty)str+=empty;rows.push(str);}const fen=rows.join('/')+' '+fd.get('turn')+' '+(fd.get('castling')||'-')+' '+(fd.get('ep')||'-')+' 0 '+fd.get('fullmove');const request=++documentRequest,source=state.doc,sourceBoard=state.board;const edited=await api('/api/board',{method:'POST',body:{fen}});if(request!==documentRequest||source!==state.doc||sourceBoard!==state.board||!canReplaceAnalysis())return;state.doc=edited;state.path='';freeHistory.reset(state.doc,state.path);render();}});
const draw=()=>{d.querySelector('#edit-board').innerHTML=[8,7,6,5,4,3,2,1].map(rank=>[...'abcdefgh'].map((file,i)=>{const sq=file+rank,p=boardPieces[sq];return ui('<button type="button" class="square ')+((i+rank)%2===0?'light':'dark')+'" data-edit-square="'+sq+ui('" aria-label="')+sq+'">'+(p?ui('<img src="')+pieceUrl(p)+'" alt="'+p+'">':'')+ui('</button>');}).join('')).join('');d.querySelectorAll('[data-edit-square]').forEach(b=>b.onclick=()=>{if(paint)boardPieces[b.dataset.editSquare]=paint;else delete boardPieces[b.dataset.editSquare];draw();});d.querySelectorAll('[data-paint]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.paint===paint));};d.querySelectorAll('[data-paint]').forEach(b=>b.onclick=()=>{paint=b.dataset.paint;draw();});d.querySelector('#clear-position').onclick=()=>{boardPieces={};d.querySelector('[name=castling]').value='-';draw();};d.querySelector('#start-position').onclick=()=>{boardPieces=pieces(START);d.querySelector('[name=castling]').value='KQkq';draw();};draw();}
async function boot(){try{status=await api('/api/status');applyAnalysisEngine(status.engine);const identity=JSON.stringify([status.username,status.workspace_epoch||'initial']);switchWorkspaceIdentity(identity);const prefs=await api('/api/preferences');state.preferences=prefs;configureSound(prefs);applyTextSize(prefs);preferencesService.open(status.username,{initial:prefs,epoch:status.workspace_epoch||'initial'});setLanguage(prefs.language||getLanguage());document.body.dataset.theme=prefs.theme||'copper';applyAppearance(prefs);displayPreferences.applyDisplayPreferences?.();await workspace.open(status.username,{remote:!!status.capabilities?.workspace_persistence,namespace:status.workspace_epoch||'initial'});pruneEmptyAnalyses(workspace);computerHistory.open(status.username,{enabled:!!status.capabilities?.computer_history,namespace:status.workspace_epoch||'initial'});reportProgress.open(status.username,{namespace:status.workspace_epoch||'initial'});computerSnapshot=workspace.get(COMPUTER_WORKSPACE_KEY);const startup=startupPreferences(),hasRoute=!!globalThis.location?.hash?.startsWith('#/'),route=hasRoute?routeFromHash(globalThis.location.hash):{page:startup.page};await loadLibrary();workspaceRestoring=true;try{await restoreStartup(route,{hasRoute,startup});}finally{workspaceRestoring=false;}sectionNavigation.start(currentRoute());}catch(e){app.innerHTML=ui('<main class="startup-error-page"><div class="startup-error-card"><h1>ChessGym</h1><p>')+esc(e.message)+ui('</p><button id="retry">Réessayer</button></div></main>');document.getElementById('retry').onclick=boot;}}
window.addEventListener('keydown',e=>{if(e.defaultPrevented||document.querySelector('dialog[open]')||state.page!=='board'||!state.board||!(e.ctrlKey||e.metaKey)||e.altKey||e.target.closest?.('input,textarea,select,[contenteditable="true"],dialog'))return;const key=e.key.toLowerCase(),direction=key==='z'?(e.shiftKey?'redo':'undo'):key==='y'?'redo':null;if(!direction)return;e.preventDefault();editHistory(direction).catch(fail);});
window.addEventListener('online',()=>{void computerHistory.flush();});
window.addEventListener('pagehide',()=>{captureAnnotation();persistAnalysis();persistReview();trainingViewPage==='computer'&&trainingView?.pauseGame?.({render:false,explicit:false});persistComputer();void workspace.flush();void computerHistory.flush();});
window.addEventListener('beforeunload',e=>{captureAnnotation();persistAnalysis();persistReview();persistComputer();if(workspace.localError&&(hasUnsavedAnalysis()||drafts.has(state.doc)||computerSessionSnapshot(computerSnapshot))){e.preventDefault();e.returnValue='';}});
try{applyAppearance({theme:localStorage.getItem('chessgym-theme')});}catch{applyAppearance();}boot();
