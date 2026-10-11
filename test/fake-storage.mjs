// In-memory stand-in for chrome.storage.local / chrome.storage.session.
export function area() {
  let data = {};
  return {
    async get(key) {
      if (key === undefined || key === null) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(values) {
      data = { ...data, ...structuredClone(values) };
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
    dump: () => data,
  };
}
export function fakeStorage() {
  return { local: area(), session: area() };
}
