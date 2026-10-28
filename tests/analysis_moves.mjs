import assert from 'node:assert/strict';
import {analysisMovesHtml,importedMoveEvaluation,moveScore,renderAnalysisMovesInto} from '../static/analysis-moves.js';
import {evaluationLoss,preferredEvaluation,moveMetricContext} from '../static/move-metrics.js';
import {recordPositionEvaluation} from '../static/position-evaluation.js';
import {setLanguage} from '../static/i18n.js';

const fen=(side,number)=>'8/8/8/8/8/8/8/K6k '+side+' - - 0 '+number;
function document(side='w',number=1){return {headers:{Result:'*'},nodes:[{path:'',parent:null,fen:fen(side,number),children:[],comment:'',starting_comment:''}]};}
function add(doc,parent,path,san,extra={}){
 const before=doc.nodes.find(node=>node.path===parent),fields=before.fen.split(' '),after=fields[1]==='w'?'b':'w';
 before.children.push(path);const node={path,parent,san,uci:'a1a2',fen:fen(after,Number(fields[5])+(after==='w'?1:0)),children:[],nags:[],comment:'',starting_comment:'',...extra};doc.nodes.push(node);return node;
}
const paths=html=>[...html.matchAll(/data-path="([^"]*)"/g)].map(match=>match[1]);
const rows=html=>[...html.matchAll(/<div class="analysis-move-row">(.*?)<\/div>/g)].map(match=>match[1]);
const stored=(node,extra={})=>({path:node.path,fen:node.fen,cp:35,depth:18,...extra});
const tests={
 deepest_evaluation_wins_without_downgrading_ties_or_missing_depth(){
  const old={cp:42,depth:18},deeper={mate:-3,depth:19};
  assert.equal(preferredEvaluation(old,deeper),deeper);
  for(const depth of [undefined,null,-1,'30',17,18,NaN,Infinity])assert.equal(preferredEvaluation(old,{cp:900,depth}),old);
  for(const bad of [null,{}, {cp:null,depth:30},{cp:NaN,depth:30},{mate:1.5,depth:30}])assert.equal(preferredEvaluation(old,bad),old);
  assert.equal(preferredEvaluation(null,deeper),deeper);assert.equal(preferredEvaluation({cp:null},deeper),deeper);
  const unknown={cp:0};assert.equal(preferredEvaluation(unknown,{cp:80}),unknown);assert.equal(preferredEvaluation(unknown,{cp:80,depth:0}).cp,80);
 },
 move_scores_prefer_depth_and_remain_usable_without_a_report(){
  const doc=document(),node=add(doc,'','0','e4',{comment:'[%eval +0.23,20]'}),nodes=new Map(doc.nodes.map(n=>[n.path,n]));
  for(const [depth,source,cp] of [[19,'pgn',23],[20,'stored',67],[21,'stored',67]]){
   const context=moveMetricContext(doc,{positions:[stored(node,{cp:67,depth})]},nodes);
   assert.equal(context.evaluation(node).source,source);assert.equal(context.evaluation(node).cp,cp);
  }
  for(const data of [null,{positions:[]},{stale:true,positions:[stored(node,{depth:30})]},{positions:[stored(node,{fen:'other',depth:30})]}]){
   const value=moveMetricContext(doc,data,nodes).evaluation(node);assert.equal(value.cp,23);assert.equal(value.depth,20);
  }
 },
 loss_prefers_deepest_scores_but_keeps_a_complete_comparable_pair(){
  const doc=document(),first=add(doc,'','0','e4',{comment:'[%eval -0.50,22]'}),nodes=new Map(doc.nodes.map(n=>[n.path,n]));
  doc.nodes[0].comment='[%eval 1.50,22]';
  const data={positions:[stored(doc.nodes[0],{cp:20}),stored(first,{cp:0})]};
  let metric=moveMetricContext(doc,data,nodes).metrics(first);assert.equal(metric.loss.lossCp,200);assert.equal(metric.loss.after.source,'pgn');
  doc.nodes[0].comment='[%eval 1.50,17]';metric=moveMetricContext(doc,data,nodes).metrics(first);assert.equal(metric.evaluation.cp,-50);assert.equal(metric.loss.lossCp,20);assert.equal(metric.loss.after.source,'stored');
  first.comment='[%eval -0.50,17]';metric=moveMetricContext(doc,data,nodes).metrics(first);assert.equal(metric.loss.lossCp,20);assert.equal(metric.loss.after.source,'stored');
  metric=moveMetricContext(doc,null,nodes).metrics(first);assert.equal(metric.loss.lossCp,200);assert.equal(metric.loss.after.source,'pgn');
 },
 live_position_analysis_preserves_report_deltas_for_both_colours_and_variations(){
  let doc=document();const first=add(doc,'','0','e4'),second=add(doc,'0','0.0','e5'),alternative=add(doc,'','1','d4');
  const report={positions:[stored(doc.nodes[0],{cp:100}),stored(first,{cp:0}),stored(second,{cp:100}),stored(alternative,{cp:30})]},original=structuredClone(report);
  const metric=path=>moveMetricContext(doc,report,new Map(doc.nodes.map(node=>[node.path,node]))).metrics(doc.nodes.find(node=>node.path===path));
  const losses=()=>[first,second,alternative].map(node=>metric(node.path).loss?.lossCp);
  assert.deepEqual(losses(),[100,100,70]);
  for(const [node,cp] of [[first,-50],[alternative,-20]]){
   doc=recordPositionEvaluation(doc,node.path,node.fen,{cp,depth:22},report.positions.find(value=>value.path===node.path));
   assert.equal(metric(node.path).evaluation.cp,cp);assert.equal(metric(node.path).evaluation.source,'pgn');
   assert.deepEqual(losses(),[100,100,70],'one deeper score must not erase any complete report comparison');
   const html=analysisMovesHtml(doc,node.path,report,null,null,{evaluationMode:'loss',highlightEvaluation:true});
   assert.ok(!html.includes('analysis-score-missing'));assert.match(html,/Source de la comparaison : Analyse Stockfish enregistrée/);
   assert.match(html,/Évaluations avant\/après : \+1,00 → 0,00/);assert.match(html,/Profondeurs avant\/après : 18\/18/);
  }
  doc=recordPositionEvaluation(doc,second.path,second.fen,{cp:150,depth:23},report.positions[2]);
  assert.equal(metric(second.path).loss.lossCp,200);assert.equal(metric(second.path).loss.after.source,'pgn','a complete deeper pair updates the delta');
  assert.deepEqual(report,original,'live analysis must not modify the saved report');
 },

 mainline_rows_pair_both_colours_and_fullmove_numbers(){
  const doc=document(),e4=add(doc,'','0','e4'),e5=add(doc,'0','0.0','e5'),nf3=add(doc,'0.0','0.0.0','Nf3');
  const html=analysisMovesHtml(doc,nf3.path,{positions:[stored(e4),stored(e5,{cp:-28}),stored(nf3,{cp:0})]});
  assert.deepEqual(paths(html),['0','0.0','0.0.0']);assert.equal(rows(html).length,2);assert.deepEqual(paths(rows(html)[0]),['0','0.0']);
  assert.match(rows(html)[1],/analysis-move-number[^>]*>2/);assert.match(html,/1… e5 · Analyse Stockfish enregistrée · profondeur 18 · −0,28/);
  assert.match(html,/data-path="0.0.0"[^>]+aria-current="true"/);assert.match(html,/>0,00<\/span>/);assert.equal((html.match(/aria-current/g)||[]).length,1);
 },
 black_fen_start_preserves_number_and_empty_white_cell(){
  const doc=document('b',20);add(doc,'','0','Kh2');add(doc,'0','0.0','Ka2');add(doc,'0.0','0.0.0','Kh3');
  const html=analysisMovesHtml(doc),rendered=rows(html);assert.equal(rendered.length,2);
  assert.match(rendered[0],/analysis-move-number[^>]*>20/);assert.match(rendered[0],/analysis-move-empty[^>]*>…/);assert.match(rendered[0],/aria-label="20… Kh2/);
  assert.deepEqual(paths(rendered[1]),['0.0','0.0.0']);assert.match(rendered[1],/21\. Ka2/);assert.match(rendered[1],/21… Kh3/);
 },
 alternatives_appear_at_branch_point_before_continuation(){
  const doc=document();add(doc,'','main','e4');add(doc,'','alt','d4');add(doc,'main','main.0','e5');add(doc,'main.0','main.0.0','Nf3');add(doc,'alt','alt.0','d5');
  const html=analysisMovesHtml(doc);assert.deepEqual(paths(html),['main','alt','alt.0','main.0','main.0.0']);
  assert.equal(rows(html).length,3);assert.deepEqual(paths(rows(html)[0]),['main']);assert.deepEqual(paths(rows(html)[1]),['main.0']);
  assert.match(rows(html)[1],/analysis-move-empty[^>]*>…/);
 },
 nested_variations_keep_child_order_without_losing_moves(){
  const doc=document();add(doc,'','4','e4');add(doc,'4','4.7','e5');add(doc,'4','4.1','c5');add(doc,'4','4.0','e6');add(doc,'4.7','4.7.0','Nf3');
  add(doc,'4.1','4.1.2','Nf3');add(doc,'4.1','4.1.0','Nc3');add(doc,'4.1.2','4.1.2.0','d6');add(doc,'4.1.2','4.1.2.1','Nc6');add(doc,'4.1.2.0','4.1.2.0.0','d4');
  const html=analysisMovesHtml(doc);assert.deepEqual(paths(html),['4','4.7','4.1','4.1.2','4.1.0','4.1.2.0','4.1.2.1','4.1.2.0.0','4.0','4.7.0']);
  assert.equal(new Set(paths(html)).size,doc.nodes.length-1);assert.equal((html.match(/class="analysis-variation"/g)||[]).length,4);
 },
 comments_nags_and_result_are_preserved_near_their_move(){
  const doc=document();doc.nodes[0].comment='Introduction';doc.headers.Result='1-0';
  add(doc,'','0','e4',{comment:'Après e4 [%clk 0:10:00] [%eval 0.3]',starting_comment:'Avant e4',nags:[1,14,999]});add(doc,'0','0.0','e5');
  const html=analysisMovesHtml(doc);assert.ok(html.indexOf('Introduction')<html.indexOf('Avant e4'));assert.ok(html.indexOf('Avant e4')<html.indexOf('data-path="0"'));
  assert.ok(html.indexOf('Après e4')>html.indexOf('data-path="0"'));assert.ok(html.indexOf('Après e4')<html.indexOf('data-path="0.0"'));
  assert.match(html,/!\+\/= \$999/);assert.match(html,/analysis-moves-result">1-0/);assert.ok(!html.includes('[%clk'));assert.ok(!html.includes('[%eval'));
 },
 report_requires_path_and_fen_and_must_not_be_stale(){
  const doc=document(),node=add(doc,'','0','e4');
  assert.match(analysisMovesHtml(doc,'',{positions:[stored(node)]}),/data-eval-source="stored"/);
  for(const report of [{status:'stale',positions:[stored(node)]},{stale:true,positions:[stored(node)]},{positions:[stored(node,{path:'other'})]},{positions:[stored(node,{fen:'different'})]}])assert.ok(!analysisMovesHtml(doc,'',report).includes('data-eval-source'));
  assert.match(analysisMovesHtml(doc,'',{status:'running',positions:[stored(node)]}),/\+0,35/);
 },
 imported_evaluations_work_for_variations_and_deeper_scores_take_precedence(){
  const doc=document(),main=add(doc,'','0','e4',{comment:'[%eval +0.23,20]'});add(doc,'','1','d4',{comment:'[%eval #-3,24]'});
  const html=analysisMovesHtml(doc,'',{positions:[stored(main,{cp:67})]});assert.match(html,/\+0,23/);assert.ok(!html.includes('+0,67'));assert.match(html,/−M3/);assert.match(html,/Évaluation du PGN · profondeur 24/);
  const stale=analysisMovesHtml(doc,'',{status:'stale',positions:[stored(main)]});assert.match(stale,/\+0,23/);assert.ok(!stale.includes('data-eval-source="stored"'));
  assert.deepEqual(importedMoveEvaluation('[%eval #-2,19]'),{mate:-2,depth:19,source:'pgn'});assert.deepEqual(importedMoveEvaluation('[%eval -0.01]'),{cp:-1,depth:null,source:'pgn'});
 },
 scores_handle_zero_mate_and_missing_without_fake_zero(){
  assert.equal(moveScore(null),null);assert.equal(moveScore({cp:null}),null);assert.equal(moveScore({cp:'0'}),null);assert.equal(moveScore({cp:NaN}),null);assert.equal(moveScore({cp:0}),'0,00');
  assert.equal(moveScore({mate:3}),'+M3');assert.equal(moveScore({mate:-2}),'−M2');assert.equal(moveScore({mate:0,winner:'black'}),'−M0');assert.equal(moveScore({mate:0}),'M0');
  const doc=document();add(doc,'','0','e4');const html=analysisMovesHtml(doc);assert.ok(!html.includes('data-eval-source'));assert.match(html,/analysis-score-missing[^>]*>—/);assert.match(html,/e4 · Pas d’évaluation enregistrée/);
  for(const raw of ['[%eval null]','[%eval NaN]','[%eval Infinity]','[%eval 1e2]','[%eval 1.234]','[%eval 100001]','[%eval 1<script>]'])assert.equal(importedMoveEvaluation(raw),null);
 },
 elapsed_times_stay_with_their_moves_scores_and_variations(){
  const doc=document(),main=add(doc,'','0','e4',{clock:599,elapsed:3,comment:'[%eval 0.25]'});
  add(doc,'','1','d4',{clock:580,elapsed:20});add(doc,'0','0.0','e5',{clock:598,elapsed:8});add(doc,'0.0','0.0.0','Nf3',{clock:0,elapsed:0});
  add(doc,'0.0.0','0.0.0.0','Nc6',{clock:null,elapsed:2.5});
  const before=structuredClone(doc),html=analysisMovesHtml(doc,main.path);
  const move=path=>html.match(new RegExp('<button[^>]*data-path="'+path+'"[^>]*>.*?</button>'))?.[0];
  assert.equal((html.match(/class="analysis-move-clock"/g)||[]).length,5);
  assert.match(move('0'),/Temps pris pour ce coup : 3 s/);assert.match(move('0'),/data-eval-source="pgn"[^>]*>\+0,25/);
  assert.match(move('1'),/Temps pris pour ce coup : 20 s/);assert.match(move('0.0'),/Temps pris pour ce coup : 8 s/);
  assert.match(move('0.0.0'),/Temps pris pour ce coup : 0 s/);assert.match(move('0.0.0.0'),/Temps pris pour ce coup : 2,5 s/);assert.deepEqual(doc,before);
 },
 missing_or_invalid_elapsed_times_do_not_fall_back_to_remaining_clocks(){
  for(const elapsed of [undefined,null,NaN,Infinity,-1,'600','<img onerror="bad">']){
   const doc=document();add(doc,'','0','e4',{clock:600,elapsed});const html=analysisMovesHtml(doc);
   assert.ok(!html.includes('analysis-move-clock'));assert.ok(!html.includes('Temps pris pour ce coup'));assert.ok(!html.includes('<img'));
  }
 },
 elapsed_time_labels_are_translated_without_changing_notation(){
  const doc=document('b',20);add(doc,'','0','Kh2',{clock:600,elapsed:3605});add(doc,'0','0.0','Ka2',{elapsed:.4});
  try{setLanguage('en');const html=analysisMovesHtml(doc);assert.match(html,/20… Kh2/);assert.match(html,/Time taken for this move: 1:00:05/);assert.match(html,/Time taken for this move: 0.4 s/);assert.ok(!html.includes('Temps pris pour ce coup'));}
  finally{setLanguage('fr');}
 },
 untrusted_text_and_paths_cannot_inject_html(){
  const doc=document();doc.nodes[0].comment='<script>alert(1)</script>';doc.headers.Result='<img onerror="bad">';const bad='x" onclick="evil';
  add(doc,'',bad,'<svg onload="bad">',{comment:'<a href="javascript:bad">Comment</a>',starting_comment:'<b>before</b>',nags:['<img onerror=bad>']});
  const html=analysisMovesHtml(doc,bad);assert.ok(!html.includes('<script'));assert.ok(!html.includes('<svg'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('<a href'));assert.ok(!html.includes(' onclick="evil'));
  assert.match(html,/data-path="x&amp;quot;|data-path="x&quot;/);assert.match(html,/&lt;b&gt;before&lt;\/b&gt;/);assert.match(html,/&lt;img onerror=bad&gt;/);
 },
 empty_and_cyclic_documents_are_finite(){
  assert.match(analysisMovesHtml(document()),/Joue un coup/);assert.match(analysisMovesHtml({nodes:[]}),/Aucun coup/);
  const doc=document(),node=add(doc,'','0','e4');node.children.push('0','missing','');assert.deepEqual(paths(analysisMovesHtml(doc)),['0']);
 },

 loss_uses_the_mover_perspective_and_lichess_judgements(){
  const doc=document(),first=add(doc,'','0','e4'),second=add(doc,'0','0.0','e5');
  const report={positions:[stored(doc.nodes[0],{cp:150}),stored(first,{cp:0}),stored(second,{cp:200})]};
  const before=structuredClone(doc),html=analysisMovesHtml(doc,'',report,null,null,{evaluationMode:'loss',highlightEvaluation:true});
  const move=path=>html.match(new RegExp('<button[^>]*data-path="'+path+'"[^>]*>.*?</button>'))[0];
  assert.match(move('0'),/data-eval-severity="mistake"/);assert.match(move('0'),/>−1,50<\/span>/);
  assert.match(move('0.0'),/data-eval-severity="blunder"/);assert.match(move('0.0'),/>−2,00<\/span>/);
  assert.match(html,/Évaluations avant\/après : \+1,50 → 0,00/);assert.deepEqual(doc,before);
 },
 loss_requires_a_complete_matching_source_pair(){
  const doc=document(),node=add(doc,'','0','e4',{comment:'[%eval 0.00]'}),opts={evaluationMode:'loss'};
  let report={positions:[stored(doc.nodes[0],{cp:100})]};
  assert.match(analysisMovesHtml(doc,'',report,null,null,opts),/analysis-score-missing/);
  doc.nodes[0].comment='[%eval 1.50,18]';
  assert.match(analysisMovesHtml(doc,'',report,null,null,opts),/data-eval-source="pgn"[^>]*>−1,50/);
  report={positions:[stored(doc.nodes[0],{cp:300,engine_identity:'a'}),stored(node,{cp:0,engine_identity:'b'})]};
  assert.match(analysisMovesHtml(doc,'',report,null,null,opts),/data-eval-source="pgn"[^>]*>−1,50/);
  doc.nodes[0].comment='';node.comment='';
  const namedReport={positions:[stored(doc.nodes[0],{engine_name:'Engine A'}),stored(node,{engine_name:'Engine B'})]};
  assert.match(analysisMovesHtml(doc,'',namedReport,null,null,opts),/analysis-score-missing/);
  assert.match(analysisMovesHtml(doc,'',report,null,null,opts),/analysis-score-missing/);
  for(const bad of [{stale:true,positions:[stored(doc.nodes[0]),stored(node)]},{positions:[stored(doc.nodes[0]),stored(node,{fen:'changed'})]}]){
   const html=analysisMovesHtml(doc,'',bad,null,null,opts);assert.match(html,/analysis-score-missing/);assert.ok(!html.includes('data-eval-severity'));
  }
 },
 engine_best_move_and_improvements_never_get_negative_losses_or_mate_blames(){
  for(const [before,after] of [[{cp:100,best_uci:'a1a2'},{cp:-500}],[{mate:3,best_uci:'a1a2'},{cp:40}],[{cp:0,best_uci:'a1a2'},{mate:-2}],[{cp:0},{cp:50}]]){
   const loss=evaluationLoss(before,after,'white','a1a2');assert.equal(loss.lossCp,0);assert.equal(loss.judgement,null);assert.equal(loss.mateChange,null);
  }
  assert.equal(evaluationLoss({cp:100},null,'white','a1a2'),null);
  assert.equal(evaluationLoss({cp:100},{cp:0},'invalid','a1a2'),null);
 },
 lichess_thresholds_and_lopsided_positions_are_contextual(){
  const judgement=cp=>evaluationLoss({cp:0},{cp:-cp},'white','a1a2').judgement;
  for(const [cp,expected] of [[54,null],[55,'inaccuracy'],[110,'inaccuracy'],[111,'mistake'],[168,'mistake'],[169,'blunder']])assert.equal(judgement(cp),expected);
  assert.equal(evaluationLoss({cp:800},{cp:650},'white','a1a2').judgement,null);
  assert.equal(evaluationLoss({cp:70},{cp:0},'white','a1a2').judgement,'inaccuracy');
  assert.equal(evaluationLoss({cp:150},{cp:0},'white','a1a2').judgement,'mistake');
 },
 mates_have_explicit_labels_and_no_fabricated_pawn_loss(){
  const cases=[
   [{mate:3},{cp:0},'missed','blunder'],
   [{mate:3},{cp:800},'missed','mistake'],
   [{mate:3},{cp:1000},'missed','inaccuracy'],
   [{cp:0},{mate:-2},'allowed','blunder'],
   [{cp:-800},{mate:-2},'allowed','mistake'],
   [{cp:-1000},{mate:-2},'allowed','inaccuracy'],
   [{mate:3},{mate:5},'retained',null],
   [{mate:-3},{mate:-1},'forced',null],
   [{mate:-3},{cp:-200},'escaped',null],
  ];
  for(const [before,after,change,judgement] of cases){
   const loss=evaluationLoss(before,after,'white','a1a2');assert.equal(loss.lossCp,null);assert.equal(loss.mateChange,change);assert.equal(loss.judgement,judgement);
  }
  const doc=document();doc.nodes[0].comment='[%eval #3]';add(doc,'','0','e4',{comment:'[%eval 0]'});
  const html=analysisMovesHtml(doc,'',null,null,null,{evaluationMode:'loss',highlightEvaluation:true});
  assert.match(html,/>Mat manqué<\/span>/);assert.match(html,/data-eval-severity="blunder"/);
  doc.nodes[0].comment='[%eval 0]';doc.nodes[1].comment='[%eval #0]';
  assert.match(analysisMovesHtml(doc,'',null,null,null,{evaluationMode:'loss'}),/>Mat trouvé<\/span>/);
 },
 time_accents_use_strict_initial_budget_thresholds_in_both_modes(){
  const doc=document();doc.headers.TimeControl='600+5';add(doc,'','0','e4',{elapsed:30,clock:575});
  add(doc,'0','0.0','e5',{elapsed:30.1,clock:574.9});add(doc,'0.0','0.0.0','Nf3',{elapsed:60,clock:520});
  add(doc,'0.0.0','0.0.0.0','Nc6',{elapsed:60.1,clock:519.8});
  for(const timeMode of ['elapsed','remaining']){
   const html=analysisMovesHtml(doc,'',null,null,null,{timeMode,highlightTime:true});
   const move=path=>html.match(new RegExp('<button[^>]*data-path="'+path+'"[^>]*>.*?</button>'))[0];
   assert.ok(!move('0').includes('data-time-severity'));assert.match(move('0.0'),/data-time-severity="moderate"/);
   assert.match(move('0.0.0'),/data-time-severity="moderate"/);assert.match(move('0.0.0.0'),/data-time-severity="high"/);
   assert.match(move('0.0.0'),/10 % du temps initial \(10:00\)/);assert.match(move('0'),new RegExp('data-time-mode="'+timeMode+'"'));
  }
  assert.match(analysisMovesHtml(doc,'',null,null,null,{timeMode:'remaining'}),/<\/svg>9:35<\/span>/);
  assert.match(analysisMovesHtml(doc,'',null,null,null,{timeMode:'elapsed'}),/<\/svg>30 s<\/span>/);
 },
 unknown_initial_budget_or_clock_never_creates_a_time_accent(){
  for(const control of [undefined,'?','-','0+5','40/7200:3600','9'.repeat(400)]){
   const doc=document();doc.headers.TimeControl=control;add(doc,'','0','e4',{elapsed:500,clock:0});
   const html=analysisMovesHtml(doc,'',null,null,null,{highlightTime:true,timeMode:'remaining'});
   assert.ok(!html.includes('data-time-severity'));assert.match(html,/<\/svg>0:00<\/span>/);
  }
  const doc=document();doc.headers.TimeControl='600+5';add(doc,'','0','e4',{elapsed:null,clock:500});
  const html=analysisMovesHtml(doc,'',null,null,null,{highlightTime:true});assert.ok(!html.includes('data-time-severity'));assert.ok(!html.includes('class="analysis-move-clock"'));
 },
 automatic_accents_preserve_user_nags_and_can_be_disabled_independently(){
  const doc=document();doc.headers.TimeControl='600';doc.nodes[0].comment='[%eval 0]';add(doc,'','0','e4',{comment:'[%eval -3]',nags:[1],elapsed:70});
  const original=structuredClone(doc),opts={evaluationMode:'loss',highlightEvaluation:true,highlightTime:true};
  const html=analysisMovesHtml(doc,'0',null,null,null,opts);
  assert.match(html,/analysis-move-nags">!<\/span>/);assert.match(html,/analysis-move-judgement"[^>]*>\?\?<\/span>/);
  assert.match(html,/class="move analysis-move current"/);assert.match(html,/data-eval-severity="blunder"/);assert.match(html,/data-time-severity="high"/);
  const quiet=analysisMovesHtml(doc,'',null,null,null,{...opts,highlightEvaluation:false});
  assert.ok(!quiet.includes('data-eval-severity'));assert.ok(quiet.includes('data-time-severity'));assert.deepEqual(doc,original);
 },
 display_changes_invalidate_cached_rows_but_cursor_changes_preserve_them(){
  const doc=document();add(doc,'','0','e4',{elapsed:3,clock:599});
  const button={dataset:{path:'0'},classList:{toggle(){}},getAttribute(){return '';},setAttribute(){},removeAttribute(){}};
  const host={writes:0,set innerHTML(value){this.html=value;this.writes++;},querySelectorAll(selector){return selector==='[data-path]'?[button]:[];}};
  const opts={display:{evaluationMode:'loss',timeMode:'elapsed',highlightEvaluation:true,highlightTime:true}};
  assert.equal(renderAnalysisMovesInto(host,doc,'',null,null,null,opts).changed,true);
  assert.equal(renderAnalysisMovesInto(host,doc,'0',null,null,null,opts).changed,false);assert.equal(host.writes,1);
  opts.display.timeMode='remaining';
  assert.equal(renderAnalysisMovesInto(host,doc,'0',null,null,null,opts).changed,true);assert.equal(host.writes,2);
  assert.equal(renderAnalysisMovesInto(host,doc,'',null,null,null,{display:{...opts.display}}).changed,false);
  opts.display.highlightTime=false;
  assert.equal(renderAnalysisMovesInto(host,doc,'0',null,null,null,opts).changed,true);assert.equal(host.writes,3);
 },
};
const scenario=process.argv[2];assert.ok(tests[scenario],'Unknown scenario '+scenario);await tests[scenario]();console.log('OK '+scenario);
