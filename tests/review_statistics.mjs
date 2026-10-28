import {setLanguage} from '../static/i18n.js';
import assert from 'node:assert/strict';
import {ReviewStatistics,formatDuration,barChart,activityHeatmap} from '../static/review-statistics.js';
import {TestNode as Host} from './metadata_dom.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const summary=(overrides={})=>({reviewed:4,elapsed_ms:180000,grade_counts:[1,0,2,1],assisted:1,unique_cards:3,days_studied:2,mean_seconds:45,median_seconds:35,...overrides});
const current=(overrides={})=>({total:12,unseen:5,learning:3,learned:4,mastered:0,due_now:2,overdue:1,new_available_today:3,quota_resets_at:'2026-10-21T00:00:00+00:00',quota_timezone:'UTC',...overrides});
function response(overrides={}){
 return {generated_at:'2026-10-20T15:00:00Z',time_zone:'America/Toronto',today:'2026-10-20',filters:{base_id:null,days:90,bases:[{id:1,name:'Ouvertures <blanches>',type:'moves',review_enabled:true,has_history:true},{id:2,name:'Anciennes finales',type:'play',review_enabled:false,has_history:true}]},period:{start:'2026-10-18',end:'2026-10-20',days:3},summary:{today:summary(),period:summary({reviewed:7,grade_counts:[1,1,3,2]})},current:current(),planner:['now','1h','4h','1d','3d','7d'].map((key,i)=>({key,at:'2026-10-20T15:00:00Z',due:i+2,estimated_minutes:i===0?.5:i+1,assumed_cards:1})),estimates:{window_days:90,by_type:[{type:'moves',seconds:15,sample_count:0,assumed:true},{type:'solve',seconds:40,sample_count:5,assumed:false},{type:'play',seconds:240,sample_count:0,assumed:true}]},forecast:{days:30,overdue:1,items:[{date:'2026-10-20',count:1},{date:'2026-10-21',count:2}],note:'deadlines_only'},activity:[{date:'2026-10-18',count:0,elapsed_ms:0,grade_counts:[0,0,0,0],assisted:0},{date:'2026-10-19',count:3,elapsed_ms:120000,grade_counts:[0,1,1,1],assisted:0},{date:'2026-10-20',count:4,elapsed_ms:180000,grade_counts:[1,0,2,1],assisted:1}],streak:{current:2,longest:2,scope:'period'},intervals:[{key:'lt1',count:2},{key:'1to7',count:3},{key:'7to30',count:1},{key:'30to90',count:1},{key:'90plus',count:0}],by_base:[{base_id:1,name:'Ouvertures <blanches>',type:'moves',review_enabled:true,current:current(),period:summary()},{base_id:2,name:'Anciennes finales',type:'play',review_enabled:false,current:current({total:0,unseen:0,learning:0,learned:0,due_now:0,overdue:0,new_available_today:0}),period:summary()}],scope:{workload:'active_enabled',history:'existing_bases_including_inactive',deleted_bases_retained:false},...overrides};
}
function fixture(options={}){
 const host=new Host(),requests=[],changes=[],opened=[],reviewed=[];
 const component=new ReviewStatistics(host,{request:async url=>{requests.push(url);return response();},onOptionsChange:options=>changes.push(options),onOpenBase:id=>opened.push(id),onReviewBase:id=>reviewed.push(id),...options});
 return {host,component,requests,changes,opened,reviewed,content:()=>host.querySelector('[data-rs-content]'),click(action){host.emit('click',host.querySelector('[data-rs-action="'+action+'"]'));},change(name,value){const node=host.querySelector('[data-rs-control="'+name+'"]');node.value=value;host.emit('change',node);}};
}
const tests={
 async english_statistics_translate_labels_not_database_names(){
  setLanguage('en');const f=fixture({request:async()=>response({by_base:[{base_id:1,name:'Révisions',type:'solve',review_enabled:true,current:current({progress_counts:{mastered:1,learned:2,due:2,unlearned:7}}),period:summary()}]})});await tick();const html=f.content().innerHTML;assert.match(html,/Plan my session/);assert.match(html,/Card states/);assert.match(html,/Answer ratings/);assert.match(html,/<strong>Révisions<\/strong>/);assert.match(html,/Not learned : 7/);assert.doesNotMatch(html,/En apprentissage|Notes des réponses|Période de l’historique/);assert.match(f.host.innerHTML,/History period/);f.component.dispose();setLanguage('fr');
 },
 async exclusive_progress_matches_overview_and_does_not_duplicate_mastered(){
  const progress_counts={mastered:2,learned:1,due:2,unlearned:7},c=current({mastered:2,progress_counts});
  const f=fixture({request:async()=>response({current:c,by_base:[{base_id:1,name:'Base',type:'solve',review_enabled:true,current:c,period:summary()}]})});await tick();const html=f.content().innerHTML;
  assert.equal((html.match(/class="review-progress-track"/g)||[]).length,2,'overall and per-base bars use the same states');assert.match(html,/Maîtrisés : 2 · Appris : 1 · À réviser : 2 · Non appris : 7/);assert.match(html,/États de progression/);assert.match(html,/chaque carte une seule fois/);f.component.dispose();
 },
 async loads_default_period_and_local_timezone(){
  const f=fixture();assert.equal(f.content().getAttribute('aria-busy'),'true');await tick();
  const query=new URL(f.requests[0],'http://localhost').searchParams;
  assert.equal(query.get('days'),'90');assert.equal(query.get('base_id'),null);assert.equal(query.get('tz'),null,'Server study-day settings determine the quota timezone');
  assert.equal(f.content().getAttribute('aria-busy'),'false');assert.match(f.host.querySelector('[data-rs-status]').textContent,/America\/Toronto/);
  assert.match(f.content().innerHTML,/Planifier ma séance/);assert.match(f.content().innerHTML,/Calendrier d’activité/);
 },
 async filters_request_scope_and_keep_control_nodes(){
  const f=fixture();await tick();const base=f.host.querySelector('[data-rs-control="base"]'),days=f.host.querySelector('[data-rs-control="days"]');
  f.change('base','2');await tick();f.change('days','7');await tick();
  const query=new URL(f.requests.at(-1),'http://localhost').searchParams;
  assert.equal(query.get('base_id'),'2');assert.equal(query.get('days'),'7');
  assert.equal(f.host.querySelector('[data-rs-control="base"]'),base);assert.equal(f.host.querySelector('[data-rs-control="days"]'),days);
  assert.deepEqual(f.changes.at(-1),{baseId:2,days:7,historyMetric:'count'});
 },
 async stale_response_cannot_replace_new_filter(){
  const pending=[];const f=fixture({request:url=>new Promise(resolve=>pending.push({url,resolve}))});
  f.change('days','30');pending[1].resolve(response({today:'new',summary:{today:summary({reviewed:99}),period:summary()}}));await tick();
  const html=f.content().innerHTML;pending[0].resolve(response({today:'old'}));await tick();assert.equal(f.component.data.today,'new');assert.equal(f.content().innerHTML,html);
 },
 async disposed_component_ignores_late_response_and_events(){
  let resolve;const f=fixture({request:()=>new Promise(r=>resolve=r)});const html=f.content().innerHTML;
  f.component.dispose();resolve(response());await tick();assert.equal(f.content().innerHTML,html);assert.equal(f.component.data,null);assert.equal(f.host.listeners.size,0);
  await f.component.load();assert.equal(f.component.data,null);
 },
 async late_failure_cannot_erase_new_success(){
  const pending=[];const f=fixture({request:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  f.click('refresh');pending[1].resolve(response());await tick();const html=f.content().innerHTML;
  pending[0].reject(Error('Old error'));await tick();assert.equal(f.content().innerHTML,html);assert.equal(f.content().getAttribute('aria-busy'),'false');
 },
 async error_is_escaped_and_retry_loads_data(){
  let calls=0;const f=fixture({request:async()=>{if(!calls++)throw Error('<img src=x onerror=alert(1)>');return response();}});await tick();
  assert.match(f.content().innerHTML,/&lt;img/);assert.doesNotMatch(f.content().innerHTML,/<img/);assert.equal(f.content().getAttribute('aria-busy'),'false');
  f.click('refresh');await tick();assert.match(f.content().innerHTML,/Échéances à venir/);
 },
 async deleted_saved_base_has_recovery_to_all_bases(){
  const requests=[];const f=fixture({options:{baseId:99},request:async url=>{requests.push(url);if(url.includes('base_id=99'))throw Object.assign(Error('Base introuvable.'),{status:404});return response();}});
  assert.equal(f.host.querySelector('[data-rs-control="base"]').value,'99');await tick();
  assert.ok(f.host.querySelector('[data-rs-action="all-bases"]'));f.click('all-bases');await tick();
  assert.equal(f.component.options.baseId,null);assert.equal(new URL(requests.at(-1),'http://localhost').searchParams.has('base_id'),false);assert.match(f.content().innerHTML,/État des cartes/);
 },
 async values_labels_and_estimates_have_honest_definitions(){
  const f=fixture();await tick();const html=f.content().innerHTML;
  assert.match(html,/75 %/);assert.match(html,/Bien.*Facile/);assert.match(html,/ce n’est pas un taux de mémorisation/);
  assert.match(html,/Les nombres sont cumulatifs/);assert.match(html,/Les nouvelles cartes/);assert.match(html,/Ce n’est pas une simulation/);
  assert.match(html,/1<\/strong> en retard avant aujourd’hui/);assert.match(html,/sur 30 jours/);assert.match(html,/estimation indicative/);assert.match(html,/5 réponses mesurées/);
  assert.match(html,/nouvelles cartes disponibles pour apprendre/);assert.doesNotMatch(html,/renouvellement du quota/);assert.match(html,/dans la période affichée/);assert.match(html,/Manqué/);
 },
 async empty_history_has_no_invented_percent_or_personal_duration(){
  const zero=summary({reviewed:0,elapsed_ms:0,grade_counts:[0,0,0,0],assisted:0,unique_cards:0,days_studied:0,mean_seconds:null,median_seconds:null});
  const f=fixture({request:async()=>response({summary:{today:zero,period:zero},current:current({total:0,unseen:0,learning:0,learned:0,due_now:0,new_available_today:0}),intervals:[],by_base:[],activity:[{date:'2026-10-20',count:0,elapsed_ms:0}],streak:{current:0,longest:0}})});await tick();
  const html=f.content().innerHTML;assert.match(html,/Aucune révision sur cette période/);assert.match(html,/Aucune carte active/);assert.match(html,/Acti|active/);assert.match(html,/>—<\/strong>/);assert.doesNotMatch(html,/NaN|Infinity|100 %|échéances sont prêtes/);
 },
 async heatmap_has_accessible_day_values_and_roving_focus(){
  const f=fixture();await tick();const days=f.host.querySelectorAll('[data-rs-day]');
  assert.equal(days.length,3);assert.equal(days.filter(node=>node.getAttribute('tabindex')==='0').length,1);assert.match(days[1].getAttribute('aria-label'),/3 révisions/);assert.match(days[1].getAttribute('title'),/2 min/);
  f.host.emit('click',days[1]);assert.equal(days[1].getAttribute('aria-pressed'),'true');assert.equal(days[1].getAttribute('tabindex'),'0');assert.match(f.host.querySelector('[data-rs-day-detail]').textContent,/3 révisions, 2 min/);
  let prevented=false;f.component.handleKey({target:days[1],key:'Home',preventDefault:()=>prevented=true});assert.equal(prevented,true);assert.equal(days[0].getAttribute('tabindex'),'0');assert.match(f.host.querySelector('[data-rs-day-detail]').textContent,/0 révision, 0 s/);
 },
 async history_metric_changes_without_network_and_preserves_options(){
  const f=fixture();await tick();const calls=f.requests.length,time=f.host.querySelector('[data-rs-metric="time"]');
  f.host.emit('click',time);assert.equal(f.requests.length,calls);assert.equal(time.getAttribute('aria-pressed'),'true');assert.equal(f.component.options.historyMetric,'time');assert.equal(f.changes.at(-1).historyMetric,'time');
  const history=f.host.querySelector('[data-rs-history]');assert.match(history.innerHTML,/Axe vertical : minutes/);assert.match(history.innerHTML,/5 min/);assert.match(history.innerHTML,/Voir les valeurs/);
 },
 async base_actions_are_scoped_and_disabled_history_is_preserved(){
  const f=fixture();await tick();const html=f.content().innerHTML;
  assert.match(html,/Anciennes finales/);assert.match(html,/révisions désactivées/);assert.match(html,/bases désactivées encore présentes/);assert.equal(f.host.querySelectorAll('[data-rs-action="review-base"]').length,1);
  f.click('open-base');f.click('review-base');assert.deepEqual(f.opened,[1]);assert.deepEqual(f.reviewed,[1]);
  const rogue=new Host('button',{'data-rs-action':'review-base','data-rs-base':'2'});f.component.handleClick({target:rogue});assert.deepEqual(f.reviewed,[1]);
 },
 async base_names_and_server_errors_are_not_html(){
  const f=fixture();await tick();assert.match(f.content().innerHTML,/Ouvertures &lt;blanches&gt;/);assert.doesNotMatch(f.content().innerHTML,/<blanches>/);assert.match(f.host.querySelector('[data-rs-control="base"]').innerHTML,/&lt;blanches&gt;/);
 },
 async saved_options_restore_metric_and_invalid_filters_are_normalized(){
  const f=fixture({options:{baseId:2,days:30,historyMetric:'time'}});await tick();assert.match(f.requests[0],/days=30/);assert.match(f.requests[0],/base_id=2/);assert.match(f.host.querySelector('[data-rs-history]').innerHTML,/Axe vertical : minutes/);
  const other=fixture({options:{baseId:'<script>',days:22,historyMetric:'fake'}});await tick();assert.deepEqual(other.component.options,{baseId:null,days:90,historyMetric:'count'});
 },
 async mastered_cards_are_in_learned_without_duplicate_distribution_and_no_review_action(){
  const counts=current({total:3,unseen:0,learning:0,learned:3,mastered:3,due_now:0,overdue:0,new_available_today:0});
  const f=fixture({request:async()=>response({current:counts,by_base:[{base_id:1,name:'Tactiques simples',type:'solve',review_enabled:true,current:counts,period:summary()}],intervals:[]})});await tick();
  const html=f.content().innerHTML;
  assert.match(html,/Apprises \(dont 3 maîtrisées\)/);
  assert.match(html,/<td>3<small>dont 3 maîtrisées<\/small><\/td>/);
  assert.match(html,/Les cartes maîtrisées sont exclues/);
  const stateCard=html.split('<h2>État des cartes</h2>')[1].split('<h3>Intervalles de révision</h3>')[0];
  assert.equal((stateCard.match(/<li>/g)||[]).length,2);assert.match(stateCard,/100 %/);
  const review=f.host.querySelector('[data-rs-action="review-base"]');
  assert.ok(review.hasAttribute('disabled'));assert.match(review.getAttribute('title'),/maîtrisées/);
  f.host.emit('click',review);assert.deepEqual(f.reviewed,[]);
  f.click('open-base');assert.deepEqual(f.opened,[1]);
  // A stale/inconsistent due count must not permit launching a mastered-only base.
  f.component.data.by_base[0].current.due_now=2;f.host.emit('click',review);assert.deepEqual(f.reviewed,[]);
 },
 charts_and_durations_are_bounded_and_offer_accessible_values(){
  assert.equal(formatDuration(0),'0 s');assert.equal(formatDuration(65000),'1 min 5 s');assert.equal(formatDuration(3660000),'1 h 1 min');
  const chart=barChart([{date:'2026-10-20',count:0},{date:'2026-10-21',count:3}]);assert.match(chart,/role="img"/);assert.match(chart,/<title>/);assert.match(chart,/Voir les valeurs/);assert.doesNotMatch(chart,/NaN|Infinity/);
  const emptyChart=barChart([]);assert.match(emptyChart,/Aucune donnée/);
  const heatmap=activityHeatmap([{date:'2026-10-20',count:0,elapsed_ms:0}]);assert.match(heatmap,/rs-level-0/);assert.match(heatmap,/tabindex="0"/);assert.doesNotMatch(heatmap,/NaN|Infinity/);
 }
};
const name=process.argv[2];if(!tests[name])throw Error('Unknown scenario '+name);await tests[name]();console.log('PASS '+name);
