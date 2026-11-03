import { validateRun, makeEnvelope, stableStringify } from './core.mjs';

const DB_NAME = 'hci-workspace-v3';
const DB_VERSION = 1;
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function storageError(message, cause) {
  const error = new Error(message);
  error.code = 'STORAGE_ERROR';
  if (cause) error.cause = cause;
  return error;
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction._reason || storageError('이 기기에 저장하지 못했습니다. 기록을 다운로드해 보관하고 다시 시도해 주세요.', transaction.error));
    transaction.onerror = () => { /* onabort carries the transaction result. */ };
  });
}
function immutableHistory(existing, incoming) {
  if (!existing) return;
  if (existing.studyVersion !== incoming.studyVersion || stableStringify(existing.assignment) !== stableStringify(incoming.assignment) || existing.participantCode !== incoming.participantCode || existing.condition !== incoming.condition || existing.mode !== incoming.mode || existing.invitationId !== incoming.invitationId || existing.startedAt !== incoming.startedAt) {
    throw storageError('같은 실행 번호의 배정 또는 참가 정보가 변경되었습니다. 기존 기록을 보존했습니다.');
  }
  if (existing.submissions.length > incoming.submissions.length || stableStringify(existing.submissions) !== stableStringify(incoming.submissions.slice(0, existing.submissions.length))) {
    throw storageError('저장된 제출 기록보다 이전 상태이거나 다른 답안입니다. 다른 탭을 닫고 다시 불러와 주세요.');
  }
}

export class BrowserStore {
  constructor() {
    this.mode = 'memory';
    this._db = null;
    this._runs = new Map();
    this._events = new Map();
    this._writes = Promise.resolve();
    this.initError = null;
  }
  async init() {
    if (!globalThis.indexedDB) {
      this.initError = '이 환경에서는 브라우저 자동 저장을 사용할 수 없습니다.';
      return this;
    }
    try {
      this._db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        let settled=false;
        const timer = setTimeout(() => {settled=true;reject(storageError('브라우저 저장소 응답이 지연됩니다. 다른 파일럿 탭을 닫고 다시 열어 주세요.'));}, 8000);
        request.onupgradeneeded = () => {
          const db=request.result;
          if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', {keyPath:'id'});
          if (!db.objectStoreNames.contains('events')) {
            const events=db.createObjectStore('events', {keyPath:'id'});
            events.createIndex('runId','runId',{unique:false});
          }
        };
        request.onsuccess = () => {clearTimeout(timer);if(settled){request.result.close();return;}settled=true;resolve(request.result);};
        request.onerror = () => {clearTimeout(timer);if(!settled){settled=true;reject(request.error);}};
        request.onblocked = () => { /* The timeout provides a finite, visible fallback. */ };
      });
      this._db.onversionchange = () => {
        this._db.close();
        this._db = null;
        this.initError = '다른 탭에서 저장소 버전이 변경되었습니다. 현재 기록을 보관하고 페이지를 다시 열어 주세요.';
      };
      this.mode = 'indexeddb';
    } catch (error) {
      this._db = null;
      this.mode = 'memory';
      this.initError = error?.message || '브라우저 자동 저장이 제한되어 있습니다.';
    }
    return this;
  }
  _write(operation) {
    // Queue snapshots in call order; a rejected write does not poison subsequent retries.
    const current = this._writes.catch(()=>{}).then(operation);
    this._writes = current;
    return current;
  }
  async saveRun(run) {
    validateRun(run);
    const snapshot = clone(run);
    return this._write(async () => {
      if (this.mode === 'memory') {
        immutableHistory(this._runs.get(snapshot.id),snapshot);
        this._runs.set(snapshot.id,snapshot);
        return;
      }
      if (!this._db) throw storageError(this.initError || '저장소 연결이 닫혔습니다. 페이지를 다시 열어 주세요.');
      const tx = this._db.transaction('runs','readwrite');
      const done=transactionDone(tx), records=tx.objectStore('runs');
      const get=records.get(snapshot.id);
      get.onsuccess=()=> {
        try {immutableHistory(get.result,snapshot);records.put(snapshot);}
        catch (error) {tx._reason=error;tx.abort();}
      };
      await done;
    });
  }
  async getRun(id) {
    await this._writes.catch(()=>{});
    if (typeof id !== 'string') return null;
    if (this.mode === 'memory') return this._runs.has(id) ? clone(this._runs.get(id)) : null;
    if (!this._db) throw storageError(this.initError || '저장소 연결이 닫혔습니다.');
    const value=await new Promise((resolve,reject)=> {
      const tx=this._db.transaction('runs','readonly'), request=tx.objectStore('runs').get(id);
      request.onsuccess=()=>resolve(request.result ?? null);
      request.onerror=()=>reject(storageError('저장된 응답을 읽지 못했습니다.',request.error));
      tx.onabort=()=>reject(storageError('저장된 응답을 읽지 못했습니다.',tx.error));
    });
    if (value) validateRun(value);
    return value;
  }
  async appendEvents(events) {
    if (!Array.isArray(events)) throw storageError('저장할 행동 기록 형식이 올바르지 않습니다.');
    const unique=new Map();
    for (const event of clone(events)) {
      if (!event || typeof event.id!=='string' || typeof event.runId!=='string') throw storageError('행동 기록의 실행 번호가 없습니다.');
      if (unique.has(event.id) && stableStringify(unique.get(event.id))!==stableStringify(event)) throw storageError('같은 배치의 행동 번호가 중복되며 내용이 다릅니다.');
      unique.set(event.id,event);
    }
    const snapshot=[...unique.values()];
    return this._write(async()=> {
      if (!snapshot.length) return;
      if (this.mode==='memory') {
        for (const event of snapshot) {
          const existing=this._events.get(event.id);
          if (existing && stableStringify(existing)!==stableStringify(event)) throw storageError('같은 행동 번호에 서로 다른 기록이 있습니다. 원본을 보존했습니다.');
        }
        for (const event of snapshot) this._events.set(event.id,event);
        return;
      }
      if (!this._db) throw storageError(this.initError || '저장소 연결이 닫혔습니다.');
      const tx=this._db.transaction('events','readwrite'), done=transactionDone(tx), records=tx.objectStore('events');
      for (const event of snapshot) {
        const get=records.get(event.id);
        get.onsuccess=()=> {
          if (get.result && stableStringify(get.result)!==stableStringify(event)) {
            tx._reason=storageError('같은 행동 번호에 서로 다른 기록이 있습니다. 원본을 보존했습니다.');
            tx.abort();
          } else if (!get.result) records.add(event);
        };
      }
      await done;
    });
  }
  async eventsForRun(id) {
    await this._writes.catch(()=>{});
    let events;
    if (this.mode==='memory') events=[...this._events.values()].filter(event=>event.runId===id).map(clone);
    else {
      if (!this._db) throw storageError(this.initError || '저장소 연결이 닫혔습니다.');
      events=await new Promise((resolve,reject)=> {
        const tx=this._db.transaction('events','readonly'), request=tx.objectStore('events').index('runId').getAll(id);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(storageError('행동 기록을 읽지 못했습니다.',request.error));
        tx.onabort=()=>reject(storageError('행동 기록을 읽지 못했습니다.',tx.error));
      });
    }
    // Within a page, sequence is authoritative. UTC is an approximate cross-page ordering.
    return events.sort((a,b)=>a.at.localeCompare(b.at) || a.pageId.localeCompare(b.pageId) || a.sequence-b.sequence);
  }
  async exportRun(id) {
    const run=await this.getRun(id);
    if (!run) throw storageError('내보낼 실행 기록을 찾을 수 없습니다.');
    const events=await this.eventsForRun(id);
    return makeEnvelope(run,events);
  }
  async close() {
    await this._writes.catch(()=>{});
    this._db?.close();
    this._db=null;
  }
}
