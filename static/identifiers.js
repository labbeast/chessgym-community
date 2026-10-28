// UUIDs identify local records and retry receipts; they are not authentication
// secrets. HTTP access on a local network may lack crypto.randomUUID while
// crypto.getRandomValues remains available. Retain the legacy random fallback
// for environments without Web Crypto.
export function newId(){
 const source=globalThis.crypto;
 if(typeof source?.randomUUID==='function')return source.randomUUID();
 const bytes=new Uint8Array(16);
 if(typeof source?.getRandomValues==='function')source.getRandomValues(bytes);
 else for(let index=0;index<bytes.length;index++)bytes[index]=Math.floor(Math.random()*256);
 bytes[6]=(bytes[6]&15)|64;
 bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
 return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
