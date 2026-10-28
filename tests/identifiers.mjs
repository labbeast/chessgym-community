import assert from 'node:assert/strict';
import {test} from 'node:test';
import {newId} from '../static/identifiers.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function replaceCrypto(context,value){
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value});
 context.after(()=>{if(original)Object.defineProperty(globalThis,'crypto',original);else delete globalThis.crypto;});
}

test('native UUID generation retains its Crypto receiver',context=>{
 const expected='e3e487f3-49d3-46d9-808b-e290cb642ef2';
 const source={randomUUID(){assert.equal(this,source);return expected;},getRandomValues(){assert.fail('Native UUIDs should be preferred');}};
 replaceCrypto(context,source);
 assert.equal(newId(),expected);
});

test('HTTP-compatible Web Crypto creates a version 4 UUID without randomUUID',context=>{
 const source={getRandomValues(bytes){assert.equal(this,source);return bytes.fill(255);}};
 replaceCrypto(context,source);
 assert.equal(newId(),'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('legacy environments without Web Crypto can create distinct record IDs',context=>{
 replaceCrypto(context,undefined);
 const ids=Array.from({length:100},()=>newId());
 for(const id of ids)assert.match(id,uuid);
 assert.equal(new Set(ids).size,ids.length);
});
