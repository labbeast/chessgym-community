import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const base = {type: 'base', id: 1, generation: 'v1', name: 'Opening <A>'};
const overviewSource = await readFile(new URL('../static/training-overview-state.js', import.meta.url), 'utf8');
const {runMatchesBlock} = await import('data:text/javascript;base64,' + Buffer.from(overviewSource).toString('base64'));
{
 const block = {id: 'block-1', activity: 'review', unit: 'cards', resource: base,
  title: 'Current title', target: 30, options: {selection: {mode: 'due', limit: 20}, colors: ['white', 'black']}};
 const run = {block_id: block.id, week_id: 'week-1', block: structuredClone(block)};
 assert.equal(runMatchesBlock(run, block, 'week-1'), true);
 assert.equal(runMatchesBlock({...run, week_id: undefined}, block, 'week-1'), true);
 assert.equal(runMatchesBlock(run, {...block, title: 'Renamed', target: 60, resource: {...base, name: 'Renamed DB'}}, 'week-1'), true);
 assert.equal(runMatchesBlock(run, {...block, options: {colors: ['white', 'black'], selection: {limit: 20, mode: 'due'}}}, 'week-1'), true);
 for (const changed of [
  {...block, id: 'block-2'}, {...block, activity: 'reading'}, {...block, unit: 'games'},
  {...block, resource: {...base, id: 2}}, {...block, resource: {...base, generation: 'v2'}},
  {...block, resource: {...base, type: 'tool'}},
  {...block, options: {...block.options, selection: {mode: 'new', limit: 20}}},
  {...block, options: {...block.options, colors: ['black', 'white']}}
 ]) assert.equal(runMatchesBlock(run, changed, 'week-1'), false);
 assert.equal(runMatchesBlock(run, block, 'week-2'), false);
 assert.equal(runMatchesBlock({...run, block: undefined}, block, 'week-1'), false);
 assert.equal(runMatchesBlock({...run, block: {title: block.title}}, block, 'week-1'), false);
 assert.equal(runMatchesBlock({...run, block: {...block, resource: {...base, generation: undefined}}}, block, 'week-1'), false);
 const withoutOptions = {...block, options: undefined};
 assert.equal(runMatchesBlock({...run, block: withoutOptions}, {...withoutOptions, options: {}}, 'week-1'), true);
}
console.log('Training overview state: all checks passed.');
