import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ResearchStore } from '../web/research-store.mjs';

test('stale research tabs cannot overwrite another tab grades or invitations', async () => {
  globalThis.indexedDB=new IDBFactory();
  const first=await new ResearchStore().init(), stale=await new ResearchStore().init();
  const state={...first.state,ratings:{response:{rater1:{score:1}}},invitations:[{id:'first-invite'}]};
  await first.save(state);
  await assert.rejects(stale.save({...stale.state,ratings:{response:{rater2:{score:2}}}}),/다른 연구자 탭/);
  const reopened=await new ResearchStore().init();
  assert.equal(reopened.state.ratings.response.rater1.score,1);
  assert.equal(reopened.state.invitations[0].id,'first-invite');
  await reopened.save({...reopened.state,ratings:{response:{rater1:{score:1},rater2:{score:2}}}});
  const final=await new ResearchStore().init();assert.equal(final.state.ratings.response.rater2.score,2);
  for(const store of [first,stale,reopened,final])store.db.close();
});
