const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export class TestNode{
 constructor(tag='div',attrs={}){
  this.tag=tag;this.attrs={...attrs};this.dataset={};this.nodes=[];this.listeners=new Map();this.disabled='disabled' in attrs;this.checked='checked' in attrs;this.value=attrs.value||'';
  for(const [name,value] of Object.entries(attrs))if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
  this.classList={toggle:(name,on)=>{const values=new Set((this.attrs.class||'').split(' ').filter(Boolean));on?values.add(name):values.delete(name);this.attrs.class=[...values].join(' ');}};
 }
 get innerHTML(){return this.html||'';}set innerHTML(value){this.html=value;this.nodes=parse(value);}
 get all(){return this.nodes.flatMap(n=>[n,...n.all]);}
 get lastElementChild(){return this.nodes.at(-1);}
 setAttribute(name,value){this.attrs[name]=value;}getAttribute(name){return this.attrs[name]??null;}hasAttribute(name){return name in this.attrs;}
 matches(selector){
  if(selector.startsWith('.'))return (this.attrs.class||'').split(' ').includes(selector.slice(1));
  const m=selector.match(/^\[([^=\]]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/);
  if(m){const value=m[2]??m[3];return this.hasAttribute(m[1])&&(value===undefined||this.attrs[m[1]]===value);}
  return this.tag===selector;
 }
 querySelector(selector){return this.all.find(n=>selector.split(',').some(s=>n.matches(s)))||null;}
 querySelectorAll(selector){return this.all.filter(n=>selector.split(',').some(s=>n.matches(s)));}
 closest(selector){return selector.split(',').some(s=>this.matches(s))?this:null;}
 contains(node){return this.all.includes(node);}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);if(!this.listeners.get(name)?.size)this.listeners.delete(name);}
 emit(name,target=this){const event={target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};for(const fn of this.listeners.get(name)||[])fn(event);return event;}
 insertAdjacentHTML(position,html){if(position!=='beforeend')throw Error(position);this.nodes.push(...parse(html));}
 focus(){}
}
function parse(html){
 const root=new TestNode(),stack=[root];
 for(const match of html.matchAll(/<(\/)?([a-z][a-z0-9]*)\b([^>]*)>/g)){
  if(match[1]){if(stack.at(-1)?.tag===match[2])stack.pop();continue;}
  const attrs={};for(const a of match[3].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g))attrs[a[1]]=decode(a[2]??'');
  const node=new TestNode(match[2],attrs);stack.at(-1).nodes.push(node);
  if(!['input','br','hr','img','meta','link'].includes(node.tag))stack.push(node);
 }
 for(const node of root.all)if(node.tag==='select')node.value=(node.nodes.find(n=>n.hasAttribute('selected'))||node.nodes[0])?.value||'';
 return root.nodes;
}
export function dialogFactory(dialogs){return (title,html,settings={})=>{
 const d=new TestNode();d.innerHTML='<form>'+html+'<button type="button" data-close>Annuler</button><button type="submit">'+(settings.submit||'Appliquer')+'</button></form>';
 Object.assign(d,{title,settings,open:true});d.close=()=>d.open=false;dialogs.push(d);return d;
};}
