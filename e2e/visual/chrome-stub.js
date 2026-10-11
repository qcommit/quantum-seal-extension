// Visual check only: the few chrome.* calls the UI makes outside common.js.
if (!globalThis.chrome?.runtime?.getManifest)
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.0' }), sendMessage: async () => {}, getURL: (p) => p },
    windows: { create: async () => {} },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  };
