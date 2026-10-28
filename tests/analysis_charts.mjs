import assert from 'node:assert/strict';
import {AnalysisCharts,chartMainline,chartModel,chartTime,chartScore,evaluationValue,contiguousSegments,clockSeries,chartSvg} from '../static/analysis-charts.js';

const rootFen='8/8/8/8/8/8/8/K6k b - - 0 20';
const doc=()=>({id:7,nodes:[{path:'',fen:rootFen,children:['2','0'],clock:null,elapsed:null},{path:'0',parent:'',fen:'alternative w - - 1 21',uci:'h1h2',san:'Kh2',children:[]},{path:'2',parent:'',fen:'first w - - 1 21',uci:'h1g1',san:'Kg1',children:['2.0'],clock:590,elapsed:null},{path:'2.0',parent:'2',fen:'second b - - 2 21',uci:'a1a2',san:'Ka2',children:['2.0.0'],clock:580,elapsed:0},{path:'2.0.0',parent:'2.0',fen:'third w - - 3 22',uci:'g1g2',san:'Kg2',children:[],clock:585,elapsed:10}]});
const report=d=>({status:'done',positions:chartMainline(d).map((p,index)=>({path:p.path,fen:p.fen,ply:index,cp:index*100,mate:null}))});
class Element{
 constructor(dataset={}){this.dataset=dataset;this.attrs={};this.style={};this.hidden=false;this.textContent='';}
 setAttribute(name,value){this.attrs[name]=String(value);if(name==='hidden')this.hidden=true;}
 removeAttribute(name){delete this.attrs[name];if(name==='hidden')this.hidden=false;}
 toggleAttribute(name,enabled){enabled?this.setAttribute(name,''):this.removeAttribute(name);}
 hasAttribute(name){return name in this.attrs;}
 focus(){globalThis.document.activeElement=this;}
 closest(selector){return selector==='[data-analysis-graph]'&&this.hasAttribute('data-analysis-graph')?this:selector==='[data-chart-tab]'&&this.dataset.chartTab?this:null;}
 getBoundingClientRect(){return {left:0,width:700};}
}
class Host{
 constructor(){this.handlers=new Map();this.html='';}
 addEventListener(type,fn){this.handlers.set(type,fn);}
 removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);}
 contains(element){return !!element&&[this.graph,this.tooltip,this.branch,...Object.values(this.tabs||{})].includes(element);}
 set innerHTML(html){this.html=html;this.selection=new Element();this.hover=new Element();this.graph=new Element();this.graph.setAttribute('data-analysis-graph','');this.graph.querySelector=selector=>selector==='[data-chart-selection]'?this.selection:selector==='[data-chart-hover]'?this.hover:null;this.tooltip=new Element();this.tooltip.parentElement=new Element();this.tooltip.getBoundingClientRect=()=>({left:0,width:220});this.branch=new Element();this.tabs={evaluation:new Element({chartTab:'evaluation'}),time:new Element({chartTab:'time'})};}
 get innerHTML(){return this.html;}
 querySelector(selector){return selector==='[data-analysis-graph]'?this.graph:selector==='[data-chart-tooltip]'?this.tooltip:selector==='[data-chart-branch]'?this.branch:this.tabs[selector.match(/^\[data-chart-tab="([^"]+)"\]$/)?.[1]]||null;}
}
globalThis.document={activeElement:null};
function setup(){const host=new Host(),board={doc:doc(),path:'',busy:false,inputLocked:false,disposed:false,calls:[],async go(path){this.path=path;this.calls.push(path);}},charts=new AnalysisCharts(host,{board});return {host,board,charts};}
const key=(target,name,extras={})=>({target,key:name,prevented:0,stopped:0,preventDefault(){this.prevented++;},stopPropagation(){this.stopped++;},...extras});
const settle=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
const tests={
 position_evaluations_are_visible_without_full_analysis_and_prefer_depth(){
  const d=doc(),data=report(d);d.nodes[2].comment='[%eval -0.75,20]';d.nodes[3].comment='[%eval #-2,22]';
  data.positions.forEach(p=>p.depth=18);
  let model=chartModel(d,data);assert.equal(model.points[1].evaluation.cp,-75);assert.equal(model.points[1].evaluation.source,'pgn');assert.equal(model.points[2].value,-500);
  for(const depth of [20,21]){data.positions[1].depth=depth;assert.equal(chartModel(d,data).points[1].evaluation.source,'stored');}
  for(const report of [null,{...data,stale:true},{...data,status:'stale'}]){model=chartModel(d,report);assert.equal(model.evaluated,2);assert.equal(model.points[1].value,-75);}
  data.positions[1].fen='obsolete';assert.equal(chartModel(d,data).points[1].value,-75);
 },
 position_updates_refresh_chart_and_tooltip_without_changing_line(){
  const {charts,board,host}=setup();charts.updateReport(report(board.doc));
  board.doc.nodes[2].comment='[%eval -0.75,20]';charts.update();assert.equal(charts.model.points[1].value,-75);
  charts.showTooltip(1);assert.match(host.tooltip.textContent,/−0,75/);
  board.doc.nodes[2].comment='[%eval #3,21]';charts.update();assert.equal(charts.model.points[1].value,500);
  charts.showTooltip(1);assert.match(host.tooltip.textContent,/\+M3/);
  charts.updateReport({status:'stale'});assert.equal(charts.model.evaluated,1);assert.ok(!host.innerHTML.includes('La partie a changé'));
  charts.dispose();
 },
 tooltip_stays_inside_graph_at_edges_and_after_resize(){
  const {charts,host}=setup();
  for(const mode of ['evaluation','time']){
   charts.mode=mode;charts.render();
   for(const stageWidth of [650,280,360]){
    const stageLeft=123.5,graphInset=6,graphWidth=stageWidth-2*graphInset,tipWidth=Math.min(mode==='time'?430:220,stageWidth-16);
    host.tooltip.parentElement.getBoundingClientRect=()=>({left:stageLeft,width:stageWidth});
    host.graph.getBoundingClientRect=()=>({left:stageLeft+graphInset,width:graphWidth});
    host.tooltip.getBoundingClientRect=()=>({left:0,width:tipWidth});
    for(let index=0;index<charts.model.points.length;index++){
     charts.showTooltip(index);
     assert.match(host.tooltip.style.left,/px$/,'position must use measured chart geometry');
     const left=parseFloat(host.tooltip.style.left),anchor=graphInset+(32+654*index/(charts.model.points.length-1))/700*graphWidth;
     assert.ok(left>=8,'bubble respects the left margin');assert.ok(left+tipWidth<=stageWidth-8+1e-6,'bubble stays inside the right margin');
     if(anchor-tipWidth/2>=8&&anchor+tipWidth/2<=stageWidth-8)assert.ok(Math.abs(left+tipWidth/2-anchor)<1e-6,'bubble centers over a move when space permits');
     assert.equal(host.tooltip.style.transform,'none');assert.equal(host.tooltip.hidden,false);assert.ok(host.tooltip.textContent.includes(charts.model.points[index].label));
    }
    assert.ok(Math.abs(parseFloat(host.tooltip.style.left)+tipWidth-(stageWidth-8))<1e-6,'last-move bubble is anchored inside the right edge');
   }
  }
  charts.dispose();
 },
 unsaved_analysis_explains_how_to_enable_evaluations(){const {charts,board,host}=setup();delete board.doc.id;charts.update();assert.match(host.innerHTML,/Active le moteur pour analyser la position/);charts.mode='time';charts.render();assert.match(host.innerHTML,/Horloges max./);charts.dispose();},
 async late_navigation_cannot_replace_latest_tooltip(){const {charts,board,host}=setup(),pending=[];board.go=async function(path){this.path=path;await new Promise(resolve=>pending.push(resolve));};const first=charts.navigate(1),second=charts.navigate(3);pending[1]();await second;assert.match(host.tooltip.textContent,/21… Kg2/);pending[0]();await first;assert.match(host.tooltip.textContent,/21… Kg2/);const third=charts.navigate(2);board.doc=structuredClone(board.doc);pending[2]();await third;assert.match(host.tooltip.textContent,/21… Kg2/);charts.dispose();},
 mainline_uses_child_order_and_parent_fen(){const line=chartMainline(doc());assert.deepEqual(line.map(p=>p.path),['','2','2.0','2.0.0']);assert.deepEqual(line.map(p=>p.label),['Position initiale','20… Kg1','21. Ka2','21… Kg2']);assert.deepEqual(line.map(p=>p.side),[null,'black','white','black']);const cyclic=doc();cyclic.nodes.at(-1).children=['2'];assert.equal(chartMainline(cyclic).length,4);},
 missing_time_never_becomes_zero(){const d=doc();d.nodes[2].clock='590';d.nodes[3].elapsed=0;d.nodes[4].clock=NaN;const model=chartModel(d,null);assert.equal(model.points[1].clock,null);assert.equal(model.points[1].elapsed,null);assert.equal(model.points[2].elapsed,0);assert.equal(model.points[3].clock,null);assert.equal(model.elapsedCount,2);assert.equal(model.clockCount,1);assert.equal(chartTime(null),'Non disponible');assert.equal(chartTime(0),'0 s');assert.equal(chartTime(62),'1:02');assert.equal(chartTime(3661),'1:01:01');assert.equal(chartTime(.25),'0,3 s');},
 evaluation_white_pov_mate_and_clamp(){assert.equal(evaluationValue({cp:900}),500);assert.equal(evaluationValue({cp:-900}),-500);assert.equal(evaluationValue({mate:-3}),-500);assert.equal(evaluationValue({mate:0,winner:'white'}),500);assert.equal(evaluationValue({mate:0,winner:'black'}),-500);assert.equal(evaluationValue({mate:0}),null);assert.equal(evaluationValue({cp:null}),null);assert.equal(chartScore({mate:0,winner:'black'}),'Mat · Noirs gagnent');assert.equal(chartScore({cp:-125}),'−1,25');assert.equal(chartScore({cp:0}),'0,00');assert.equal(chartScore({mate:4}),'+M4');},
 report_gaps_stale_and_fen_mismatch(){const d=doc(),data=report(d);data.positions=data.positions.filter(p=>p.ply!==1);data.positions[1].fen='obsolete';const model=chartModel(d,data);assert.equal(model.evaluated,2);assert.deepEqual(model.points.map(p=>p.value),[0,null,null,300]);assert.equal(chartModel(d,{...data,status:'stale'}).evaluated,0);assert.equal(chartModel(d,{...data,stale:true}).evaluated,0);},
 svg_does_not_bridge_missing_evaluations(){const d=doc(),data=report(d);data.positions.splice(1,1);const model=chartModel(d,data),segments=contiguousSegments(model.points,p=>p.value);assert.deepEqual(segments.map(s=>s.map(p=>p.index)),[[0],[2,3]]);const svg=chartSvg(model,'evaluation');assert.equal((svg.match(/class="chart-eval-line"/g)||[]).length,2);assert.equal((svg.match(/class="chart-eval-area"/g)||[]).length,1);assert.ok(!svg.includes('NaN'));},
 clock_curves_break_on_own_missing_and_share_scale(){const points=[{index:0,side:null,clock:null},{index:1,side:'white',clock:600},{index:2,side:'black',clock:580},{index:3,side:'white',clock:null},{index:4,side:'black',clock:560},{index:5,side:'white',clock:540}];assert.deepEqual(clockSeries(points,'white').map(p=>p.clockValue),[null,600,600,null,null,540]);assert.deepEqual(clockSeries(points,'black').map(p=>p.clockValue),[null,null,580,580,560,560]);const model=chartModel(doc(),null);assert.equal(model.maxClock,590);const svg=chartSvg(model,'time');assert.match(svg,/chart-time-bar white/);assert.match(svg,/chart-time-bar black/);assert.match(svg,/chart-clock-line black/);assert.ok(!svg.includes('NaN'));},
 all_zero_values_stay_real_zero(){const d=doc();d.nodes.forEach(n=>{n.clock=0;n.elapsed=0;});const model=chartModel(d,null);assert.equal(model.maxClock,0);assert.equal(model.maxElapsed,0);const svg=chartSvg(model,'time');assert.ok(!svg.includes('NaN'));assert.ok(!svg.includes('Infinity'));assert.equal((svg.match(/chart-time-bar/g)||[]).length,3);},
 report_update_navigation_and_edit_invalidation(){const {charts,board,host}=setup();charts.updateReport(report(board.doc));assert.equal(charts.model.evaluated,4);board.path='2';charts.update();assert.equal(charts.model.evaluated,4);assert.equal(host.graph.attrs['aria-valuenow'],'1');board.doc.nodes[2].fen='changed w - - 1 21';charts.update();assert.equal(charts.model.evaluated,0);assert.match(host.innerHTML,/Active le moteur/);charts.dispose();},
 off_mainline_selection_and_tooltip_are_honest(){const {charts,board,host}=setup();charts.updateReport(report(board.doc));board.path='0';charts.update();assert.equal(host.selection.hidden,true);assert.equal(host.branch.hidden,false);assert.match(host.graph.attrs['aria-valuetext'],/hors de la ligne principale/);charts.showTooltip(1);assert.match(host.tooltip.textContent,/20… Kg1/);assert.match(host.tooltip.textContent,/\+1,00/);charts.mode='time';charts.render();charts.showTooltip(1);assert.match(host.tooltip.textContent,/Temps du coup : Non disponible/);assert.match(host.tooltip.textContent,/9:50/);charts.dispose();},
 pointer_click_and_busy_guards(){const {charts,board,host}=setup();const event={target:host.graph,clientX:250};charts.pointer(event);assert.match(host.tooltip.textContent,/20… Kg1/);charts.click(event);assert.equal(board.calls.at(-1),'2');board.busy=true;charts.click({...event,clientX:686});assert.equal(board.calls.length,1);board.busy=false;board.inputLocked=true;charts.click({...event,clientX:686});assert.equal(board.calls.length,1);charts.dispose();},
 async keyboard_claims_event_and_tab_does_not_move_board(){const {charts,board,host}=setup();const event=key(host.graph,'ArrowRight');charts.keydown(event);await settle();assert.equal(event.prevented,1);assert.equal(event.stopped,1);assert.equal(board.calls.at(-1),'2');const tabEvent=key(host.tabs.evaluation,'ArrowRight');charts.keydown(tabEvent);assert.equal(charts.mode,'time');assert.equal(board.calls.length,1);assert.equal(tabEvent.prevented,1);charts.keydown(key(host.graph,'End'));await settle();assert.equal(board.calls.at(-1),'2.0.0');charts.keydown(key(host.graph,'Home'));await settle();assert.equal(board.calls.at(-1),'');charts.keydown(key(host.graph,'ArrowRight',{ctrlKey:true}));assert.equal(board.calls.length,3);charts.dispose();},
 dispose_removes_handlers_and_ignores_late_reports(){const {charts,board,host}=setup();assert.ok(host.handlers.size>0);charts.dispose();const html=host.innerHTML;assert.equal(host.handlers.size,0);charts.updateReport(report(board.doc));charts.update();charts.click({target:host.graph,clientX:686});assert.equal(host.innerHTML,html);assert.equal(board.calls.length,0);},
 time_only_missing_fields_explained_without_fake_maximum(){const {charts,board,host}=setup();board.doc.nodes.forEach(n=>n.elapsed=null);charts.update();charts.mode='time';charts.render();assert.match(host.innerHTML,/Temps du coup absent/);assert.ok(!host.innerHTML.includes('Barres max.'));charts.updateReport({status:'stale'});assert.match(host.innerHTML,/Horloges max./);assert.ok(!host.innerHTML.includes('La partie a changé'));charts.dispose();},
 report_refresh_preserves_keyboard_focus(){const {charts,board,host}=setup();host.graph.focus();charts.updateReport(report(board.doc));assert.equal(document.activeElement,host.graph);host.tabs.time.focus();charts.mode='time';charts.updateReport(report(board.doc));assert.equal(document.activeElement,host.tabs.time);charts.dispose();}
};
const name=process.argv[2];assert.ok(tests[name],'Unknown scenario '+name);await tests[name]();console.log('OK '+name);
