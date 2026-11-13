/** A string-keyed map without a prototype: keys taken from user text, such as `__proto__` or `constructor`, are plain entries. */
export const dict = <T>(): Record<string, T> => Object.create(null);
