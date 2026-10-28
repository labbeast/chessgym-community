import {t,ui,getLanguage,LANGUAGES} from './i18n.js';
import {esc,option} from './api.js';
import {startupSettingsHtml} from './startup-settings.js';
import {soundSettingsHtml} from './sound-settings.js';
import {reviewPreferencesHtml} from './review-preferences.js';
import {learningSettingsHtml} from './learning-settings.js';
import {resourceSettingsHtml} from './resource-settings.js';
import {settingsTabsHtml} from './settings-tabs.js';
import {backupSettingsHtml as automaticBackupSettingsHtml} from './backup-settings.js';
import {appearanceSettingsHtml} from './appearance.js';
import {textSizeSettingsHtml} from './text-size.js';
import {engineManagerSettingsHtml} from './engine-manager.js';
import {setupResourcesSettingsHtml} from './setup-resources.js';
import {appUpdatesSettingsHtml} from './app-updates.js';

const button=(text,action,cls='')=>'<button class="'+cls+'" data-action="'+action+'">'+text+'</button>';

export function backupSettingsHtml(capabilities={}){
 if(capabilities?.backup_automation)return automaticBackupSettingsHtml();
 const supported=!!capabilities?.personal_backup;
 return ui('<section class="panel settings-width"><h2>Sauvegardes</h2><p class="muted">')+(supported?t('La sauvegarde personnelle contient tes bases de travail, annotations, réglages, brouillons et historique de révision. Elle exclut les grandes bases de référence.'):t('Ce serveur propose la sauvegarde complète, qui contient également les grandes bases de référence.'))+ui('</p><div class="actions">')+(supported?button(t('Sauvegarde personnelle'),'backup-personal','primary'):'')+button(t('Sauvegarde complète'),'backup-full',supported?'':'primary')+ui('</div><p class="hint">La sauvegarde complète inclut toutes les références importées et peut être très volumineuse. Conserve aussi leurs fichiers sources pour poursuivre une importation.</p></section>');
}
export function languageSettingsHtml(){
 return ui('<section class="panel settings-width"><h2>Langue</h2><label>Langue de l’interface<select id="interface-language">')+Object.entries(LANGUAGES).map(([value,label])=>option(value,label,getLanguage()).replace('<option ','<option lang="'+esc(value)+'" dir="auto" ')).join('')+ui('</select></label><p class="hint">Changer la langue ne modifie pas tes PGN, noms de bases ou annotations.</p></section>');
}
function sourceSettingsHtml(status={}){
 const version=status.version?' <bdi dir="ltr">'+esc(status.version)+'</bdi>':'';
 return '<section class="panel settings-width"><h2>ChessGym'+version+'</h2><p class="hint"><a href="https://github.com/vincentinogec/chessgym-community" target="_blank" rel="noopener noreferrer">GitHub</a> · <a href="https://github.com/vincentinogec/chessgym-community/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPL-3.0-or-later</a></p></section>';
}
export function globalSettingsHtml({preferences={},status={},bases=[],theme='copper'}={}){
 const appearance=appearanceSettingsHtml({...preferences,theme:preferences.theme||theme});
 const sections=[
  {id:'general',label:'Général',content:languageSettingsHtml()+startupSettingsHtml()+sourceSettingsHtml(status)},
  {id:'appearance',label:'Apparence',content:textSizeSettingsHtml(preferences)+appearance},
  {id:'sounds',label:'Sons',content:soundSettingsHtml(preferences)},
  {id:'reviews',label:'Révisions',content:reviewPreferencesHtml(preferences,!!status.capabilities?.review_preferences,!!status.capabilities?.review_maintenance)+(status.capabilities?.review_sessions?learningSettingsHtml(preferences,bases):'')},
  ...(status.capabilities?.engine_management?[{id:'engines',label:'Moteurs',content:engineManagerSettingsHtml()}]:[]),
  ...((status.capabilities?.setup_resources||status.capabilities?.app_updates)?[{id:'installation',label:'Installation',content:(status.capabilities?.setup_resources?setupResourcesSettingsHtml():'')+(status.capabilities?.app_updates?appUpdatesSettingsHtml():'')}]:[]),
  ...(status.capabilities?.resource_settings?[{id:'performance',label:'Performance',content:resourceSettingsHtml()}]:[]),
  {id:'backups',label:'Sauvegardes',content:backupSettingsHtml(status.capabilities)}
 ];
 return settingsTabsHtml(sections);
}
