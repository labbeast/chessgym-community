import {PRIVATE_ACCESS_MESSAGES} from './private-access-messages.js';
import appUpdateMessages from './locales/en-app-updates.js';
import setupResourceMessages from './locales/en-setup-resources.js';
import transpositionMessages from './locales/en-transpositions.js';
import trainingCompletionMessages from './locales/en-training-completion.js';
import gameReportProgressMessages from './locales/en-game-report-progress.js';
import completionMessages from './locales/en-completion.js';
import listMessages from './locales/en-list-view.js';
import exerciseMessages from './locales/en-exercises.js';
import boardMenuMessages from './locales/en-board-menu.js';
import puzzleMessages from './locales/en-puzzles.js';
import skillsMessages from './locales/en-training-skills.js';
import guessMessages from './locales/en-guess.js';
import trainingNavigationMessages from './locales/en-training-navigation.js';
// Only interface-owned literals belong here. PGNs, names and comments are data.
import interfaceMessages from './locales/en-interface.js';
import analysisMessages from './locales/en-analysis.js';
import libraryMessages from './locales/en-library.js';
import serverMessages from './locales/en-server.js';
import settingsMessages from './locales/en-settings.js';
import gameReportMessages from './locales/en-game-report.js';
import computerMessages from './locales/computer-play-en.js';
import colorMessages from './locales/en-color.js';
import trainingHistoryMessages from './locales/en-training-history.js';
import trainingStatisticsMessages from './locales/en-training-statistics.js';
import dailyReviewMessages from './locales/en-daily-review.js';
import gameSearchMessages from './locales/en-game-search.js';
import trainingTimeStatisticsMessages from './locales/en-training-time-statistics.js';
import trainingPlanMessages from './locales/en-training-plan.js';
import trainingSessionMessages from './locales/en-training-session.js';
import spanish from './locales/es.js';
import german from './locales/de.js';
import portuguese from './locales/pt.js';
import italian from './locales/it.js';
import russian from './locales/ru.js';
import chinese from './locales/zh-CN.js';
import japanese from './locales/ja.js';
import korean from './locales/ko.js';
import arabic from './locales/ar.js';
import hindi from './locales/hi.js';
import {LANGUAGES,LOCALES,validLanguage,languageDirection} from './languages.js';

export {LANGUAGES};
const english={...PRIVATE_ACCESS_MESSAGES.en,...trainingTimeStatisticsMessages,...appUpdateMessages,...setupResourceMessages,...gameReportProgressMessages,...trainingCompletionMessages,...transpositionMessages,...completionMessages,...listMessages,...boardMenuMessages,...puzzleMessages,...skillsMessages,...guessMessages,...trainingNavigationMessages,...serverMessages,...libraryMessages,...analysisMessages,...interfaceMessages,...settingsMessages,...gameReportMessages,...computerMessages,...colorMessages,...trainingHistoryMessages,...trainingStatisticsMessages,...dailyReviewMessages,...gameSearchMessages,...trainingPlanMessages,...trainingSessionMessages,...exerciseMessages};
export const sourceMessages=Object.freeze(english);
export const TRANSLATIONS=Object.freeze({en:english,es:{...spanish,...PRIVATE_ACCESS_MESSAGES.es},de:{...german,...PRIVATE_ACCESS_MESSAGES.de},pt:{...portuguese,...PRIVATE_ACCESS_MESSAGES.pt},it:{...italian,...PRIVATE_ACCESS_MESSAGES.it},ru:{...russian,...PRIVATE_ACCESS_MESSAGES.ru},'zh-CN':{...chinese,...PRIVATE_ACCESS_MESSAGES['zh-CN']},ja:{...japanese,...PRIVATE_ACCESS_MESSAGES.ja},ko:{...korean,...PRIVATE_ACCESS_MESSAGES.ko},ar:{...arabic,...PRIVATE_ACCESS_MESSAGES.ar},hi:{...hindi,...PRIVATE_ACCESS_MESSAGES.hi}});
let language='fr';
try{const saved=globalThis.localStorage?.getItem('chessgym.language');if(validLanguage(saved))language=saved;}catch{}
export function getLanguage(){return language;}
export function locale(){return LOCALES[language];}
export function direction(){return languageDirection(language);}
function applyDocumentLanguage(){const root=globalThis.document?.documentElement;if(root){root.lang=language;root.dir=direction();}}
applyDocumentLanguage();
export function setLanguage(value){
 language=validLanguage(value)?value:'fr';
 try{globalThis.localStorage?.setItem('chessgym.language',language);}catch{}
 applyDocumentLanguage();
 return language;
}
export function t(source,values){
 if(typeof source!=='string')return source;
 let result=source;
 if(language!=='fr'){
  const dictionary=TRANSLATIONS[language],trimmed=source.trim();
  // New interface labels fall back to the maintained English catalogue while
  // an updated language pack is prepared. Unknown user text remains untouched.
  const key=Object.hasOwn(dictionary,source)||Object.hasOwn(english,source)?source:trimmed;
  const translated=Object.hasOwn(dictionary,key)?dictionary[key]:Object.hasOwn(english,key)?english[key]:undefined;
  if(typeof translated==='string')result=key===source?translated:source.slice(0,source.indexOf(trimmed))+translated+source.slice(source.indexOf(trimmed)+trimmed.length);
 }
 // Values are never translated or interpreted as templates themselves.
 return values?result.replace(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match):result;
}
const escapeText=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const translatedText=source=>{const value=t(source);return value===source?source:escapeText(value);};
// This helper accepts a static HTML fragment only, before any user data is
// interpolated. It does not inspect the DOM or change PGN/annotation contents.
export function ui(source){
 if(typeof source!=='string'||language==='fr')return source;
 const attributes=source.replace(/(?<![\w:-])(title|placeholder|aria-label|alt|data-label)=(['"])(.*?)\2/g,(match,name,quote,value)=>{
  const translated=t(value);if(translated===value)return match;
  return name+'='+quote+escapeText(translated).replace(/"/g,'&quot;').replace(/'/g,'&#39;')+quote;
 });
 if(!source.includes('<')&&!source.includes('>'))return t(attributes);
 return attributes.replace(/(^|>)([^<>]+)(?=<|$)/g,(match,prefix,value)=>prefix+translatedText(value));
}
