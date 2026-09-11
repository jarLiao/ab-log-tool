/* Local task archive. Metadata and original File blobs commit in one transaction. */
(function (root) {
  'use strict';
  const DB_NAME = 'ab-log-tool-history', MAX_TASKS = 20, MAX_BYTES = 512 * 1048576;
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('当前浏览器无法使用本机历史。')); return; }
      const request = root.indexedDB.open(DB_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('tasks', {keyPath: 'id'});
        db.createObjectStore('files', {keyPath: 'id'});
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error('历史库被其他页面占用，请关闭旧页面后重试。')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function transaction(stores, mode, perform) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let value, failure;
      const tx = db.transaction(stores, mode);
      const fail = error => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure || tx.error || new Error('历史保存事务已中止。'));
      // Do not await unrelated work inside an IndexedDB transaction.
      try { perform(tx, result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }
  function list() {
    return transaction(['tasks'], 'readonly', (tx, done) => {
      tx.objectStore('tasks').getAll().onsuccess = e => done(e.target.result.sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }
  function get(id) {
    return transaction(['tasks', 'files'], 'readonly', (tx, done, fail) => {
      const entry = tx.objectStore('tasks').get(id), payload = tx.objectStore('files').get(id);
      let reads = 0;
      const finish = () => {
        if (++reads !== 2) return;
        if (!entry.result || !payload.result) { fail(new Error('这条历史已删除或日志数据不完整，请重新导入。')); return; }
        done({entry: entry.result, files: payload.result.files});
      };
      entry.onsuccess = payload.onsuccess = finish;
    });
  }
  function save(entry, files) {
    return transaction(['tasks', 'files'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('tasks');
      store.getAll().onsuccess = event => {
        try {
          const existing = event.target.result.find(item => item.id === entry.id);
          const others = event.target.result.filter(item => item.id !== entry.id);
          if (others.length >= MAX_TASKS) throw new Error('本机历史已达 20 条，请先删除不需要的记录，再保存当前任务。');
          if (others.reduce((n, item) => n + item.bytes, 0) + entry.bytes > MAX_BYTES)
            throw new Error('历史日志总大小将超过 512 MB，请先删除旧记录，再保存当前任务。');
          const record = {...entry, createdAt: existing?.createdAt || entry.updatedAt};
          tx.objectStore('files').put({id: entry.id, files});
          store.put(record); done(record);
        } catch (error) { fail(error); }
      };
    });
  }
  function touch(id, info) {
    return transaction(['tasks'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('tasks');
      store.get(id).onsuccess = event => {
        const entry = event.target.result;
        if (entry) { store.put({...entry, ...info, id, updatedAt: Date.now()}); done(true); }
        else done(false);
      };
    });
  }
  function remove(id) {
    return transaction(['tasks', 'files'], 'readwrite', tx => {
      tx.objectStore('tasks').delete(id); tx.objectStore('files').delete(id);
    });
  }
  function clear() {
    return transaction(['tasks', 'files'], 'readwrite', tx => {
      tx.objectStore('tasks').clear(); tx.objectStore('files').clear();
    });
  }
  function errorMessage(error) {
    if (error?.name === 'QuotaExceededError') return '浏览器存储空间不足，请删除旧历史或释放磁盘空间后重试。';
    if (['SecurityError', 'InvalidStateError', 'UnknownError'].includes(error?.name)) return '浏览器限制了本机存储。请在普通窗口中打开网页，或检查站点存储权限。';
    return error?.message || '无法访问本机历史，请重试。';
  }
  root.ABHistory = {list, get, save, touch, remove, clear, errorMessage, MAX_TASKS, MAX_BYTES};
})(globalThis);
