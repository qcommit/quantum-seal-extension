// In-memory stand-in for chrome.storage.local / chrome.storage.session. Like Chrome, it
// stores values as JSON and returns object keys in sorted order.
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortedJson(value[k])]));
  return value;
}
const stored = (value) => sortedJson(JSON.parse(JSON.stringify(value)));
export function area() {
  let data = {};
  return {
    async get(key) {
      if (key === undefined || key === null) return stored(data);
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, stored(data[k])]));
    },
    async set(values) {
      data = { ...data, ...stored(values) };
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
