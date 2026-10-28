import {esc,fail} from './api.js';
import {t} from './i18n.js';
import {createTrainingPanel} from './exercise-tabs.js';

// Each settings window owns its form and lifetime. Changes stay in the form
// until Save, so canceling never changes a running exercise or its defaults.
export function openTrainingSettings({host=null,title,html,onSubmit,onReady}={}){
 const dialog=host?createTrainingPanel(host,'settings'):document.createElement('dialog');dialog.className='training-settings-dialog';
 dialog.innerHTML=`<form class="dialog-form"><div class="dialog-head"><h2>${esc(title||t('Réglages'))}</h2><button type="button" data-settings-close aria-label="${esc(t('Fermer'))}">×</button></div><div class="skill-settings training-settings-fields" data-training-settings-fields>${html||''}</div><div class="dialog-actions"><button type="button" data-settings-close>${esc(t('Annuler'))}</button><button class="primary" type="submit">${esc(t('Enregistrer'))}</button></div></form>`;
 const form=dialog.querySelector('form');
 dialog.querySelectorAll('[data-settings-close]').forEach(button=>button.onclick=()=>dialog.close());
 form.onsubmit=async event=>{
  event.preventDefault();if(!dialog.open||!form.reportValidity())return;
  const button=dialog.querySelector('[type=submit]');button.disabled=true;
  try{const accepted=await onSubmit?.(new FormData(form),form);if(dialog.open&&accepted!==false)dialog.close();}
  catch(error){if(dialog.open)fail(error);}
  finally{if(dialog.open)button.disabled=false;}
 };
 dialog.addEventListener('close',()=>dialog.remove(),{once:true});
 if(!host){document.body.append(dialog);dialog.showModal();}onReady?.(form,dialog);return dialog;
}
