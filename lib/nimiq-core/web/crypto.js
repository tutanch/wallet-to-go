// The worker has its own scope and no direct access to functions/objects of the
// global scope. We import the generated JS file to make `wasm_bindgen`
// available which we need to initialize our WASM code.
importScripts(
    './comlink.min.js',
    './crypto-wasm/index.js',
);

const { CryptoUtils } = wasm_bindgen;

(async function init() {
    console.log('Initializing crypto WASM worker');

    // Load the wasm file by awaiting the Promise returned by `wasm_bindgen`.
    // Object form silences wasm-bindgen's "deprecated parameters" warning.
    // NOTE: vendored nimiq-core file — re-apply this edit if re-vendored.
    await wasm_bindgen({ module_or_path: './crypto-wasm/index_bg.wasm' });

    Comlink.expose(CryptoUtils);

    self.postMessage('NIMIQ_ONLOAD');
})();
