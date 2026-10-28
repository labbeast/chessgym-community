// Stable language identifiers shared with language_preferences.py.
// Native labels let a reader recover their language even in a different UI.
export const LANGUAGES=Object.freeze({
 fr:'Français',en:'English',es:'Español',de:'Deutsch',pt:'Português',it:'Italiano',
 ru:'Русский','zh-CN':'简体中文',ja:'日本語',ko:'한국어',ar:'العربية',hi:'हिन्दी'
});
export const LOCALES=Object.freeze({
 fr:'fr-CA',en:'en-CA',es:'es-ES',de:'de-DE',pt:'pt-BR',it:'it-IT',
 ru:'ru-RU','zh-CN':'zh-CN',ja:'ja-JP',ko:'ko-KR',ar:'ar',hi:'hi-IN'
});
export const languageDirection=value=>value==='ar'?'rtl':'ltr';
export const validLanguage=value=>typeof value==='string'&&Object.hasOwn(LANGUAGES,value);
