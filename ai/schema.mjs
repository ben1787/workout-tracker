export const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const text = { type: 'string' };
export const number = { type: 'number', minimum: 0 };
