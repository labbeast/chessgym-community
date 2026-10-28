// One teardown policy for page replacement and navigation. Isolated for tests.
export function disposeViews(views){for(const view of views){if(!view)continue;if(typeof view.dispose==='function')view.dispose();else view.disconnect?.();}}
