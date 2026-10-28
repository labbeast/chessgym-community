// Small, theme-aware interface symbols. Labels remain the accessible names.
const paths=Object.freeze({
 library:'<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="16" rx="1"/><path d="m17 5 4 14M5 8h1m6 0h1M5 16h1m6 0h1"/>',
 played:'<path d="M8 20h8M9 17h6l-1-6h-4l-1 6ZM7 20v-3h10v3"/><circle cx="12" cy="6" r="3"/>',
 repertoire:'<path d="M12 5v15M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1Z"/>',
 exercises:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 'training-plan':'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-14 5 3 3 6-5"/>',
 reviews:'<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5m-9-4 3 3 5-6"/>',
 reading:'<path d="M4 4h13a3 3 0 0 1 3 3v13H6a3 3 0 0 1-3-3V5a1 1 0 0 1 1-1Zm2 12h14M8 4v7l3-2 3 2V4"/>',
 history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
 puzzles:'<path d="M9 3H4a1 1 0 0 0-1 1v5a3 3 0 1 1 0 6v5a1 1 0 0 0 1 1h5a3 3 0 1 1 6 0h5a1 1 0 0 0 1-1v-5a3 3 0 1 0 0-6V4a1 1 0 0 0-1-1h-5a3 3 0 0 1-6 0Z"/>',
 blindfold:'<path d="M3 3l18 18M10 5.2a10 10 0 0 1 2-.2c5.5 0 9 7 9 7a17 17 0 0 1-3.2 4.1M6.2 6.2C4.2 7.8 3 10 2 12c0 0 4 7 10 7a10 10 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
 coordinates:'<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/><circle cx="12" cy="12" r="2"/>',
 color:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/><path d="M4 4h8v8H4zm8 8h8v8h-8z" fill="currentColor" stroke="none"/>',
 guess:'<path d="M4 20v-4a4 4 0 0 1 4-4h4m-3-3 3 3-3 3m4-9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/><circle cx="4" cy="20" r="1"/>',
 computer:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-5-12 3 2-3 2m6 0h4"/>',
 analysis:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18m6-18v18"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 drafts:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8m-8 4h5"/>',
 rename:'<path d="m14 5 5 5M3 21l5-1L21 7a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L4 16ZM4 16l4 4"/>',
 delete:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
 settings:'<path d="M4 6h5m4 0h7M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="11" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
 palette:'<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h3a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z"/><circle cx="7" cy="10" r=".8"/><circle cx="10" cy="7" r=".8"/><circle cx="15" cy="7" r=".8"/><circle cx="17" cy="11" r=".8"/>',
 sound:'<path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
 performance:'<path d="M4 19a10 10 0 1 1 16 0ZM12 13l5-5M5 13h1m6-9v1m6 8h1"/><circle cx="12" cy="13" r="1.5"/>',
 backup:'<path d="M4 3h14l3 3v15H3V3ZM7 3v6h10V3M7 21v-7h10v7m-3-18v3"/>',
 account:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 play:'<path d="m8 4 12 8-12 8Z"/>',
 statistics:'<path d="M4 20V10m8 10V4m8 16v-7M2 21h20"/>'
});

export function uiIcon(name,className=''){
 const body=paths[name];
 if(!body)return '';
 return '<svg class="ui-icon'+(className?' '+className:'')+'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+body+'</svg>';
}
