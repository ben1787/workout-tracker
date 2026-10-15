import { linkExerciseRecords, createExercise } from './exercise-catalog.js';
const DB_NAME = 'workout-tracker';
const DB_VERSION = 4;

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // v2: rename routines -> plans, keep workouts.
      if (db.objectStoreNames.contains('routines')) db.deleteObjectStore('routines');
      if (!db.objectStoreNames.contains('exercises')) db.createObjectStore('exercises', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('goals')) db.createObjectStore('goals', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('plans')) {
        db.createObjectStore('plans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('workouts')) {
        const store = db.createObjectStore('workouts', { keyPath: 'id' });
        store.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Workout Tracker tabs, then reload to update storage.'));
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error || new Error('Could not save data.'));
  }));
}

export const saveExercise = (exercise) => run('exercises', 'readwrite', s => s.put(exercise));
export const listExercises = () => run('exercises', 'readonly', s => s.getAll());

export const saveGoal = (goal) => run('goals', 'readwrite', s => s.put(goal));
export const listGoals = () => run('goals', 'readonly', s => s.getAll());

export const savePlan = (p) => run('plans', 'readwrite', s => s.put(p));
export const listPlans = () => run('plans', 'readonly', s => s.getAll());
export const getPlan = (id) => run('plans', 'readonly', s => s.get(id));
export const deletePlan = (id) => run('plans', 'readwrite', s => s.delete(id));

export const saveWorkout = (w) => run('workouts', 'readwrite', s => s.put(w));
// Compare and write in one transaction so a slow AI review or another tab
// cannot overwrite a newer result correction.
export async function saveWorkoutIfRevision(record, expectedRevision) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('workouts', 'readwrite');
    const store = tx.objectStore('workouts');
    const request = store.get(record.id);
    let saved = false;
    request.onsuccess = () => {
      if (!request.result || (request.result.resultsRevision || 0) !== expectedRevision) return;
      store.put(record); saved = true;
    };
    tx.oncomplete = () => resolve(saved);
    tx.onabort = () => reject(tx.error || new Error('Could not save the updated workout.'));
  });
}

export const getWorkout = (id) => run('workouts', 'readonly', s => s.get(id));
export const deleteWorkout = (id) => run('workouts', 'readwrite', s => s.delete(id));

export async function listWorkouts() {
  const all = await run('workouts', 'readonly', s => s.getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function exportAll() {
  const [plans, workouts, goals, exercises] = await Promise.all([listPlans(), listWorkouts(), listGoals(), listExercises()]);
  return { version: 4, exportedAt: Date.now(), plans, workouts, goals, exercises };
}

// Import in one transaction. Existing IDs are kept so backups from multiple
// devices can be combined, and importing the same backup twice is harmless.
export async function importBackup(data) {
  if (!data || !Array.isArray(data.plans) || !Array.isArray(data.workouts)) {
    throw new Error('Backup needs "plans" and "workouts" arrays.');
  }
  if (data.goals !== undefined && !Array.isArray(data.goals)) throw new Error('Backup goals must be an array.');
  if (data.exercises !== undefined && !Array.isArray(data.exercises)) throw new Error('Backup exercises must be an array.');
  for (const exercise of data.exercises || []) createExercise(exercise);
  const names = ['plans', 'workouts', 'goals', 'exercises'];
  for (const name of names) {
    for (const record of (data[name] || [])) {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id.trim()) {
        throw new Error(`Every ${name === 'plans' ? 'plan' : 'session'} needs a valid ID. Nothing was imported.`);
      }
    }
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    const result = { plans: 0, workouts: 0, goals: 0, exercises: 0, skipped: 0 };
    for (const name of names) {
      const store = tx.objectStore(name);
      for (const record of (data[name] || [])) {
        const request = store.get(record.id);
        request.onsuccess = () => {
          if (request.result !== undefined) result.skipped++;
          else {
            const add = store.add(record);
            add.onsuccess = () => result[name]++;
            // A duplicate within the same file is also skipped.
            add.onerror = (event) => {
              if (add.error?.name === 'ConstraintError') {
                event.preventDefault();
                event.stopPropagation();
                result.skipped++;
              }
            };
          }
        };
      }
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Import failed. Nothing was imported.'));
  });
}

// A single transaction upgrades all existing history and legacy plans without
// changing their results. Also run after imports to link older-device backups.
export async function synchronizeExerciseCatalog(extra = {}) {
  const linked = linkExerciseRecords({ exercises: await listExercises(), workouts: await listWorkouts(), plans: await listPlans(), ...extra });
  const database = await openDB();
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['exercises', 'workouts', 'plans'], 'readwrite');
    for (const name of ['exercises', 'workouts', 'plans']) for (const record of linked[name]) tx.objectStore(name).put(record);
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  return linked;
}
