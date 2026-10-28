const canonical = value => JSON.stringify(value, function(key, item) {
 return item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
});

// This is a display estimate only; the server recalculates it when starting.
export function blockPeriodGoal(block, scope) {
 const values=scope==='today'?block.today||{}:block.progress||{};
 const weekly=Number(block.progress?.target??block.target)||0;
 const target=scope==='today'&&block.metric==='minutes'?(weekly>0?Number(block.daily_target??block.session_minutes??weekly):0):weekly;
 const measured=block.metric==='minutes'?Number(values.duration_ms||0)/60000:Number(values[block.metric==='sessions'?'sessions':block.unit]||0);
 const realized=scope==='week'&&values.realized!=null?Number(values.realized):measured;
 return {target,realized,remaining:Math.max(0,target-realized)};
}

function resourceIdentity(resource) {
 if (!resource?.type) return null;
 if (!['base', 'tool'].includes(resource.type)) return resource;
 if (resource.id == null || !resource.generation) return null;
 return {type: resource.type, id: resource.id, generation: resource.generation};
}

// An old episode remains resumable separately when its block has been changed.
// Match the backend credit signature plus the options used to launch the tool.
export function runMatchesBlock(run, block, weekId) {
 if (!block?.id || run.block_id !== block.id || (run.week_id != null && run.week_id !== weekId)) return false;
 const snapshot = run.block;
 if (!snapshot?.activity || !snapshot.unit || snapshot.activity !== block.activity || snapshot.unit !== block.unit) return false;
 const source = resourceIdentity(snapshot.resource), current = resourceIdentity(block.resource);
 return source != null && current != null && canonical(source) === canonical(current)
  && canonical(snapshot.options || {}) === canonical(block.options || {});
}
