import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationActivities,desktopNavigationHtml,mobileNavigationHtml,updateNavigationActivities} from '../static/main-navigation.js';
import {setLanguage} from '../static/i18n.js';

const review=()=>({base:{id:1},cards:[{id:1},{id:2}],index:0});
const computer=()=>({version:1,session:{position:{doc:{nodes:[{path:''}]},history:[],game_over:false,result:'*'},headers:{Result:'*'},resigned:false,timeout:null}});

test('unfinished workspace activities distinguish a whole session from a completed card',()=>{
 assert.deepEqual([...navigationActivities()],[]);
 assert.deepEqual([...navigationActivities({review:review(),computer:computer()})],['reviews','computer']);
 assert(navigationActivities({review:{...review(),attempt:{finished:true}}}).has('reviews'),'A solved but ungraded card is still resumable');
 assert(!navigationActivities({review:{...review(),index:2}}).has('reviews'),'A completed legacy review is not resumable');
 assert(navigationActivities({review:{...review(),session_id:'next-batch',index:2,next_offset:2}}).has('reviews'),'A paginated session can have another batch');
 assert(!navigationActivities({review:{...review(),session_id:'finished',finishedSession:true}}).has('reviews'));
 for(const edit of [s=>s.session.resigned=true,s=>s.session.timeout='white',s=>s.session.position.game_over=true,s=>s.session.headers.Result='1-0',s=>s.session.position.result='1/2-1/2']){const value=computer();edit(value);assert(!navigationActivities({computer:value}).has('computer'));}
 assert(!navigationActivities({computer:{version:1,mode:'setup'}}).has('computer'));
});

test('only active or paused programme runs and recognised authoritative pages count',()=>{
 for(const state of ['active','paused'])assert.deepEqual([...navigationActivities({run:{id:'run',state,activity:'reading'}})],['training-plan','reading']);
 for(const state of ['preparing','completed','cancelled'])assert.equal(navigationActivities({run:{id:'run',state,activity:'reading'}}).size,0);
 assert.deepEqual([...navigationActivities({run:{id:'run',state:'active',activity:'review'}})],['training-plan','reviews']);
 assert.deepEqual([...navigationActivities({activities:['puzzles','guess','blindfold','coordinates','color','puzzles','training-history','library','<img>']})],['puzzles','guess','blindfold','coordinates','color']);
});

test('desktop and mobile dots follow labels and the reviews due count in both languages',()=>{
 for(const [language,reviewLabel,label] of [['fr','Révisions','Révisions (12) · activité non terminée'],['en','Reviews','Reviews (12) · unfinished activity']]){
  setLanguage(language);
  for(const render of [desktopNavigationHtml,mobileNavigationHtml]){
   const html=render('reviews',{unfinishedActivities:new Set(['reviews','computer']),reviewDueCount:12});
   assert.equal((html.match(/data-unfinished-activity="true"/g)||[]).length,2);
   assert(html.includes('aria-label="'+label+'"'));
   const reviews=html.match(/<button[^>]+data-page="reviews"[^>]*>([^]*?)<\/button>/)?.[1];
   assert.match(reviews,new RegExp('<span class="navigation-item-label">'+reviewLabel+'<\\/span><span class="navigation-review-count"[^>]*>\\(12\\)<\\/span><span class="navigation-activity-dot"[^>]*><\\/span>'));
   assert.equal((html.match(/class="navigation-review-count"/g)||[]).length,1,'Only Reviews receives a due count');
   assert.match(html,/<button[^>]+data-page="training-history"[^>]*><svg\b[^>]*aria-hidden="true"[^>]*>[^]*?<\/svg><span class="navigation-item-label">[^<]+<\/span><span class="navigation-activity-dot"[^>]* hidden><\/span>/);
   for(const count of [0,null]){
    const plain=render('reviews',{reviewDueCount:count}),row=plain.match(/<button[^>]+data-page="reviews"[^>]*>([^]*?)<\/button>/)?.[1];
    assert.match(row,/<span class="navigation-activity-dot"[^>]* hidden>/,'A due count alone is not an unfinished activity');
    if(count===null)assert.match(row,/<span class="navigation-review-count"[^>]* hidden[^>]*>/,'Unknown counts stay hidden');
    else{assert.match(row,/<span class="navigation-review-count"[^>]*>\(0\)<\/span>/);assert.doesNotMatch(row,/<span class="navigation-review-count"[^>]* hidden/,'Known zero is still displayed');}
   }
  }
 }
 setLanguage('fr');
});

test('refreshing due counts and dots independently preserves buttons and clears stale accessible status',()=>{
 setLanguage('en');
 const buttons=['reviews','computer','guess'].map(page=>({dataset:{page},dot:{hidden:true},count:page==='reviews'?{hidden:true,textContent:'',removeAttribute(key){delete this[key];}}:null,attributes:{},querySelector(selector){return selector==='.navigation-activity-dot'?this.dot:selector==='.navigation-review-count'?this.count:null;},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];if(key==='title')delete this.title;}}));
 const host={querySelectorAll(){return buttons;}};
 updateNavigationActivities(host,new Set(['reviews','computer']),{reviewDueCount:12});
 assert.equal(buttons[0].dot.hidden,false);assert.equal(buttons[1].dot.hidden,false);assert.equal(buttons[2].dot.hidden,true);
 assert.equal(buttons[0].attributes['aria-label'],'Reviews (12) · unfinished activity');assert.equal(buttons[0].count.textContent,'(12)');assert.equal(buttons[0].count.hidden,false);
 updateNavigationActivities(host,new Set(['guess']),{reviewDueCount:12});
 assert.equal(buttons[0].dot.hidden,true);assert.equal(buttons[1].dot.hidden,true);assert.equal(buttons[2].dot.hidden,false);
 assert(!String(buttons[0].attributes['aria-label']).includes('unfinished'));assert.equal(buttons[0].dataset.unfinishedActivity,undefined);assert.equal(buttons[0].title,undefined);assert.equal(buttons[0].count.textContent,'(12)');assert.equal(buttons[0].count.hidden,false,'Finishing a session does not clear due reviews');
 assert.equal(buttons[2].title,'Unfinished activity');
 updateNavigationActivities(host,new Set(['reviews']),{reviewDueCount:0});assert.equal(buttons[0].count.textContent,'(0)');assert.equal(buttons[0].count.hidden,false);assert.equal(buttons[0].dot.hidden,false,'A resumable session can coexist with zero due reviews');assert.equal(buttons[0].attributes['aria-label'],'Reviews (0) · unfinished activity');
 updateNavigationActivities(host,new Set(),{reviewDueCount:null});assert.equal(buttons[0].count.hidden,true);assert.equal(buttons[0].dot.hidden,true);assert.equal(buttons[0].attributes['aria-label'],undefined);
 setLanguage('fr');
});
