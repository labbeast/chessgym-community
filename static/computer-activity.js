// Active play duration is independent of the chess clock and its increments.
// No running timestamp is persisted: closed-browser time is never reconstructed.
export const newComputerActivity=()=>({version:1,elapsed_ms:0});
export class ComputerActivity {
 constructor(state,{now=()=>performance.now()}={}){this.state=state;this.now=now;this.last=null;}
 read(){const current=this.now();if(this.last!==null){this.state.elapsed_ms=Math.min(31*86400000,this.state.elapsed_ms+Math.max(0,current-this.last));this.last=current;}return this.state;}
 start(){if(this.last===null)this.last=this.now();}
 pause(){this.read();this.last=null;}
 get running(){return this.last!==null;}
}
