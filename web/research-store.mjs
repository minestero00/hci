const EMPTY = () => ({ envelopes: [], ratings: {}, invitations: [], packet: null, role: 'rater1', gradeHistory: [] });
export class ResearchStore {
  mode = 'memory'; db = null; state = EMPTY(); lastEnvelopes = null; revision = 0;
  constructor({dbName = 'hci-workspace-research-v3'} = {}) { this.dbName = dbName; }
  async init() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspace');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      this.mode = 'indexeddb';
      const saved = await new Promise((resolve, reject) => {
        const tx = this.db.transaction('workspace'), table = tx.objectStore('workspace');
        const main = table.get('main'), data = table.get('envelopes');
        tx.oncomplete = () => resolve(main.result ? { ...main.result, envelopes: data.result || main.result.envelopes || [] } : null);
        tx.onerror = () => reject(tx.error);
      });
      if (saved && Array.isArray(saved.envelopes) && saved.ratings && Array.isArray(saved.invitations)) this.state = { ...EMPTY(), ...saved };
      this.revision=Number.isInteger(saved?.revision) ? saved.revision : 0;
      this.lastEnvelopes = this.state.envelopes;
    } catch { this.mode = 'memory'; }
    return this;
  }
  async save(state) {
    const expectedRevision=this.revision;
    if (this.mode === 'indexeddb') await new Promise((resolve, reject) => {
      const tx = this.db.transaction('workspace', 'readwrite'), table = tx.objectStore('workspace');
      const {envelopes,...metadata} = state;
      let conflict=null;
      const current=table.get('main');
      current.onsuccess=()=>{
        const savedRevision=Number.isInteger(current.result?.revision) ? current.result.revision : 0;
        if(savedRevision!==expectedRevision){conflict=Error('다른 연구자 탭에서 기록이 변경됐습니다. 현재 보관 파일을 내려받고 새로고침한 뒤 합쳐 주세요.');tx.abort();return;}
        table.put({...metadata,revision:expectedRevision+1}, 'main');
        if (this.lastEnvelopes !== envelopes) table.put(envelopes, 'envelopes');
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(conflict || tx.error); tx.onabort = () => reject(conflict || tx.error || Error('저장이 중단됐습니다.'));
    });
    this.revision=expectedRevision+1;
    this.state = state;
    this.lastEnvelopes = state.envelopes;
  }
}
