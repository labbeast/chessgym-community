import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function checkRatedBlindfold({page,api,nav,capture,output,report}){
 await page.locator('dialog.training-history-dialog [data-history-dialog-close]').first().click();
 await page.locator('[data-new]').click();await page.selectOption('[data-custom-set]','');
 assert.equal(await page.locator('[data-rated-puzzle]').count(),2);
 assert.equal(await page.locator('[data-blind-setup]').count(),0);
 await page.screenshot({path:join(output,'blindfold-puzzles-rated-setup-fr-desktop.png'),fullPage:true});
 await page.locator('[data-rated-puzzle="positions"]').click();await page.locator('[data-ready]').click();
 await page.fill('[name=move]','Dg7#');await page.locator('[data-blind-answer] [type=submit]').click();await page.locator('.skill-palette').waitFor();
 assert.equal((await api('/api/skills/blindfold/overview')).profiles.positions.rating,500,'rating is recorded when the session finishes');
 await page.reload();await page.locator('[data-page="blindfold"]').first().waitFor({state:'attached'});await nav('blindfold');await page.locator('.skill-palette').waitFor();
 assert.equal(await page.locator('.skill-prompt').count(),0);assert.equal(await page.locator('[data-result-board]').count(),0);
 for(const [piece,square] of [['K','f7'],['Q','g7'],['k','h8']]){await page.locator('[data-piece="'+piece+'"]').click();await page.locator('[data-square="'+square+'"]').click();}
 await page.locator('[data-verify]').click();await page.locator('[data-blindfold-rating-result]').waitFor();
 let profiles=(await api('/api/skills/blindfold/overview')).profiles;
 const positionWin=profiles.positions.rating;assert(positionWin>500);assert.equal(profiles.opening.rating,500);
 assert.match(await page.locator('[data-blindfold-rating-result]').textContent(),/Solution sans erreur/);
 assert.match(await page.locator('.skill-stage-outcomes').textContent(),/statistique secondaire/);
 await page.setViewportSize({width:390,height:844});await capture('blindfold-puzzles-rated-perfect-mobile','[data-result-board] .chess-board');
 await page.locator('[data-new]').click();await page.locator('[data-rated-puzzle="positions"]').click();await page.locator('[data-ready]').click();
 await page.fill('[name=move]','Dg7#');await page.locator('[data-blind-answer] [type=submit]').click();await page.locator('.skill-palette').waitFor();
 await page.locator('[data-piece="K"]').click();await page.locator('[data-square=f7]').click();await page.locator('[data-verify]').click();await page.locator('[data-blindfold-rating-result]').waitFor();
 profiles=(await api('/api/skills/blindfold/overview')).profiles;
 assert(profiles.positions.rating>positionWin);assert.equal(profiles.positions.rated_count,2);assert.equal(profiles.positions.wins,2);
 assert.match(await page.locator('[data-blindfold-rating-result]').textContent(),/Solution sans erreur/);
 assert.equal(await page.locator('.skill-result-banner.success').count(),1);
 assert.match(await page.locator('.skill-stage-outcomes').textContent(),/33.3 %/);
 await capture('blindfold-puzzles-rated-imperfect-mobile','[data-result-board] .chess-board');
 await page.locator('[data-new]').click();await page.selectOption('[data-custom-set]','positions');await page.uncheck('[name=hide_prompt]');await page.uncheck('[name=reconstruct_after]');
 await page.locator('[data-rated-puzzle="opening"]').click();await page.locator('[data-ready]').click();await page.locator('[name=move]').waitFor();assert.equal(await page.locator('.skill-prompt').count(),0);
 await page.fill('[name=move]','Fa4');await page.locator('[data-blind-answer] [type=submit]').click();await page.waitForFunction(()=>document.querySelector('.skill-played')?.textContent.includes('Cf6'));
 await page.fill('[name=move]','O-O');await page.locator('[data-blind-answer] [type=submit]').click();await page.locator('.skill-result-banner.success').waitFor();
 assert.equal(await page.locator('.skill-palette').count(),0);
 profiles=(await api('/api/skills/blindfold/overview')).profiles;assert(profiles.opening.rating>500);assert.equal(profiles.positions.rated_count,2);
 report.checks.push('Rated modes: separate profiles, curve targets, optional reconstruction, grading at session completion, mobile solve success with exact or imperfect boards, secondary accuracy, independent Openings rating and reload recovery');
 assert.equal((await api('/api/skills/blindfold/history')).history.length,6);
 await page.locator('[data-new]').click();
 await api('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('[data-page="blindfold"]').first().waitFor({state:'attached'});await nav('blindfold');await page.locator('[data-custom-set]').waitFor();
 assert.match(await page.locator('.training-tabs').getAttribute('aria-label'),/Blindfold Puzzles/);
 assert.match(await page.locator('[data-custom-set]').textContent(),/Openings/);assert.match(await page.locator('[data-custom-set]').textContent(),/Positions/);
 assert.equal(await page.locator('[data-rated-puzzle]').count(),2);assert.equal(await page.locator('[data-blind-setup]').count(),0);
 await page.screenshot({path:join(output,'blindfold-puzzles-rated-setup-en-mobile.png'),fullPage:true});
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
}
