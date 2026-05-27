const DB_NAME = 'workout-tracker';
const DB_VERSION = 2;

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // v2: rename routines -> plans, keep workouts.
      if (db.objectStoreNames.contains('routines')) db.deleteObjectStore('routines');
      if (!db.objectStoreNames.contains('plans')) {
        db.createObjectStore('plans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workouts')) {
        const store = db.createObjectStore('workouts', { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const savePlan = (p) => run('plans', 'readwrite', s => s.put(p));
export const listPlans = () => run('plans', 'readonly', s => s.getAll());
export const getPlan = (id) => run('plans', 'readonly', s => s.get(id));
export const deletePlan = (id) => run('plans', 'readwrite', s => s.delete(id));

export const saveWorkout = (w) => run('workouts', 'readwrite', s => s.put(w));
export const getWorkout = (id) => run('workouts', 'readonly', s => s.get(id));
export const deleteWorkout = (id) => run('workouts', 'readwrite', s => s.delete(id));

export async function listWorkouts() {
  const all = await run('workouts', 'readonly', s => s.getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function exportAll() {
  const [plans, workouts] = await Promise.all([listPlans(), listWorkouts()]);
  return { exportedAt: Date.now(), plans, workouts };
}
