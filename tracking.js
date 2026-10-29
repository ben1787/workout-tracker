// Done confirms prescribed reps and holds unless overridden; other measurements stay explicit.
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
export function validateTracking(tracking) {
  if (!tracking || !Array.isArray(tracking.fields) || tracking.fields.length > 8) throw new Error('Invalid exercise tracking.');
  const keys = new Set();
  for (const field of tracking.fields) {
    if (!field || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field.key) || reserved.has(field.key) || keys.has(field.key) || !['number', 'text'].includes(field.type) || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100 || typeof field.unit !== 'string' || field.unit.length > 30) throw new Error('Invalid tracking field.');
    if (['reps', 'weight', 'holdSeconds', 'minutes', 'miles'].includes(field.key) && field.type !== 'number') throw new Error('Measurements must be numeric.');
    keys.add(field.key);
  }
  return tracking;
}
export function trackingFor(ex) {
  if (ex.tracking) {
    const tracking = validateTracking(ex.tracking);
    if (ex.holdSeconds > 0 && !tracking.fields.some(field => field.key === 'holdSeconds')) {
      return { fields: [{ key: 'holdSeconds', label: 'Actual hold', unit: 'seconds', type: 'number' }, ...tracking.fields] };
    }
    if (ex.reps > 0 && !ex.holdSeconds && !tracking.fields.some(field => field.key === 'reps')) {
      return { fields: [{ key: 'reps', label: 'Actual reps', unit: 'reps', type: 'number' }, ...tracking.fields] };
    }
    return tracking;
  }
  // Conservative fallback for old routines; never add distance to a warm-up.
  const fields = [];
  const add = (key, label, unit) => fields.push({ key, label, unit, type: 'number' });
  if (!ex.type || ex.type === 'exercise') {
    if (ex.holdSeconds > 0) add('holdSeconds', 'Actual hold', 'seconds');
    if (!ex.holdSeconds && ex.reps > 0) add('reps', 'Actual reps', 'reps');
    if (ex.weight > 0) add('weight', 'External load', 'lb');
  } else if (ex.type === 'cardio' && ex.distance_miles > 0) add('miles', 'Actual distance', 'mi');
  return { fields };
}
export function trackingResult(tracking, values, prescription = {}) {
  validateTracking(tracking);
  const trackingValues = {};
  const result = { completed: true, trackingValues };
  for (const field of tracking.fields) {
    let raw = values[field.key];
    if (field.key === 'reps' && (raw == null || String(raw).trim() === '') &&
        Number.isFinite(prescription.reps) && prescription.reps > 0 && !prescription.holdSeconds) raw = prescription.reps;
    if (field.key === 'holdSeconds' && (raw == null || String(raw).trim() === '') &&
        Number.isFinite(prescription.holdSeconds) && prescription.holdSeconds > 0) raw = prescription.holdSeconds;
    if (raw == null || String(raw).trim() === '') continue;
    const value = field.type === 'number' ? Number(raw) : String(raw).trim().slice(0, 1000);
    if (field.type === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Enter a valid non-negative measurement.');
    trackingValues[field.key] = { label: field.label, unit: field.unit, value };
    const target = { minutes: 'actualMinutes', miles: 'actualMiles' }[field.key] || field.key;
    if (['reps', 'weight', 'holdSeconds', 'actualMinutes', 'actualMiles'].includes(target)) result[target] = value;
  }
  return result;
}
