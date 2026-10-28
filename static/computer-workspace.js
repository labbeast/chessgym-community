// A recoverable computer game is a workspace slot, never a library entry.
// Setup controls may describe the NEXT game, so persist the running session's
// frozen configuration and restore it as a playable game after a page reload.
export const COMPUTER_WORKSPACE_KEY='computer';
export function computerSessionSnapshot(snapshot){
 const session=snapshot?.session,position=session?.position;
 if(snapshot?.version!==1||!position||!Array.isArray(position.history)||
    !Array.isArray(position.doc?.nodes)||!position.doc.nodes.length||
    typeof position.initial_fen!=='string'||typeof position.fen!=='string'||
    !['white','black'].includes(session.side))return null;
 const copy=structuredClone(snapshot);
 copy.mode='play';copy.config=structuredClone(session.config||snapshot.config);
 copy.session.config=structuredClone(copy.config);
 copy.origin=copy.config?.start==='analysis'?structuredClone(session.start):null;
 copy.displayPath=snapshot.mode==='play'?snapshot.displayPath:position.path;
 copy.pendingMove=snapshot.mode==='play'&&!session.resigned&&!session.timeout?snapshot.pendingMove||null:null;
 return copy;
}
export function persistComputerSession(store,snapshot){
 const saved=computerSessionSnapshot(snapshot);
 // Merely visiting setup or launching another diagram must not erase a game.
 if(saved&&store.ready)store.set(COMPUTER_WORKSPACE_KEY,saved);
 return saved;
}
