import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {analysisMovesHtml,moveScore} from '../static/analysis-moves.js';
import {chartTime,chartScore} from '../static/analysis-charts.js';
import {serialize} from '../static/board.js';
import {formatNags,describeNags} from '../static/annotations.js';
import {explorerRowsHtml,explorerSettingsHtml} from '../static/explorer.js';
import {probabilityDisplay} from '../static/explorer-probability.js';
import {coverageResultsHtml,coverageRequestOptions} from '../static/repertoire-coverage.js';
import {repertoireRowsHtml} from '../static/repertoire-panel.js';
import {positionMatchesHtml,positionBasesHtml} from '../static/position-panel.js';
import {validateEngineSettings} from '../static/engine-settings.js';
import {MoveMenu} from '../static/move-menu.js';
const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const doc=()=>({headers:{Event:'Aucun coup.',White:'Blancs',Black:'Noirs',Result:'*'},nodes:[
 {path:'',parent:null,fen,children:['0'],comment:'Répertoires principaux',nags:[]},
 {path:'0',parent:'',fen:fen.replace(' w ',' b '),children:[],comment:'Aucun coup. <non traduit>',nags:[1,14],san:'e4',uci:'e2e4'}
]});
const tests={
 moves_and_pgn_data_are_never_translated(){
  const game=doc(),before=serialize(game),html=analysisMovesHtml(game,'0');
  assert.match(html,/Game moves/);assert.match(html,/No saved evaluation/);
  assert.match(html,/Good move · Slight advantage for White/);
  assert.match(html,/Aucun coup\. &lt;non traduit&gt;/);assert.match(html,/Répertoires principaux/);
  assert.equal(serialize(game),before);
  assert.equal(formatNags([1,14]),'!+/=');assert.equal(describeNags([1,14]),'Good move · Slight advantage for White');
  setLanguage('fr');
  assert.equal(describeNags([1,14]),'Bon coup · Léger avantage aux Blancs');
  assert.match(analysisMovesHtml(game,'0'),/Coups de la partie/);
 },
 explorer_filters_and_user_database_names_are_separate(){
  const settings={source:'local',master_source:'masters',base_ids:[1],master_base_ids:[],speeds:['rapid'],ratings:[1600],local_filters:{},master_local_filters:{}};
  const html=explorerSettingsHtml(settings,[{id:1,name:'Mes bases'}]);
  assert.match(html,/Game database/);assert.match(html,/Stockfish analysis/);assert.match(html,/Rapid/);
  assert.match(html,/>Mes bases<\/span>/);assert(!html.includes('Cadences Lichess'));
  const row=explorerRowsHtml({settings,primary:{status:'ok',complete:true},masters:{status:'ok'},moves:[{uci:'e2e4',san:'e4',total:10,white:6,draws:2,black:2,frequency:50,master_frequency:20,master_total:4}]});
  assert.match(row,/aria-label="Play e4"/);assert.match(row,/White: 6/);assert.match(row,/Black: 2/);assert.match(row,/game\(s\) · frequency at this position/);
 },
 numeric_displays_follow_the_language(){
  assert.equal(moveScore({cp:25}),'+0.25');assert.equal(chartScore({cp:-25}),'−0.25');assert.equal(chartTime(1.5),'1.5 s');
  assert.match(probabilityDisplay({status:'ok',probability:.01}).ratio,/1 in/);
  setLanguage('fr');assert.equal(moveScore({cp:25}),'+0,25');assert.equal(chartTime(1.5),'1,5 s');
 },
 position_results_preserve_players_and_titles(){
  const result=positionMatchesHtml({matches:[{entry_title:'Sans titre',headers:{White:'Blancs',Black:'Noirs',WhiteElo:'1700',BlackElo:'1800',Result:'1-0'},occurrences:[{path:'0',label:'1. e4'}]}]});
  assert.match(result,/position-player-side">White/);assert.match(result,/position-player-side">Black/);
  assert.match(result,/position-player-name">Blancs/);assert.match(result,/position-player-name">Noirs/);
  assert.match(positionBasesHtml({bases:[{base_name:'Sans nom',total_entries:2,total_occurrences:3}]}),/<strong>Sans nom<\/strong>/);
 },
 repertoire_status_and_validation_translate(){
  assert.match(repertoireRowsHtml({white:{name:'Répertoires principaux',compatible:true,extendable:true}}),/Add up to here/);
  assert.match(repertoireRowsHtml({white:{name:'Répertoires principaux',compatible:true,extendable:true}}),/<strong>Répertoires principaux<\/strong>/);
  assert.match(coverageResultsHtml({status:'not_scanned'}),/Start exploration/);
  assert.throws(()=>coverageRequestOptions({ratings:[],speeds:['rapid']}),/Choose at least one rating range/);
  assert.doesNotThrow(()=>validateEngineSettings({mode:'depth',depth:50,time_ms:1000}));
  assert.throws(()=>validateEngineSettings({mode:'depth',depth:0,time_ms:1000}),/depth must be a positive integer/i);
 },
 menu_labels_change_without_reloading_modules(){
  const game=doc();let element;
  const menu=Object.create(MoveMenu.prototype);
  Object.assign(menu,{getDoc:()=>game,canBookmark:()=>true,root:{closest:()=>null},window:{innerWidth:1000,innerHeight:800},
   document:{body:{append:()=>{}},documentElement:{},createElement:()=>element={setAttribute(){},querySelectorAll:()=>[],getBoundingClientRect:()=>({width:200,height:300}) ,style:{}}},
   close(){},items:()=>[]});
  menu.open('0',null);assert.match(element.innerHTML,/Promote to main line/);assert.match(element.innerHTML,/Move bookmark here/);
  setLanguage('fr');menu.open('0',null);assert.match(element.innerHTML,/Promouvoir en ligne principale/);assert.match(element.innerHTML,/Déplacer le signet ici/);
 }
};
const name=process.argv[2];assert(tests[name],name);setLanguage('en');try{await tests[name]();console.log('PASS '+name);}finally{setLanguage('fr');}

