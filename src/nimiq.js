let Nimiq;
let initPromise;

export async function loadNimiq() {
    if (Nimiq) return Nimiq;
    if (!initPromise) {
        initPromise = (async () => {
            const mod = await import('@nimiq/core');
            await mod.default();
            return mod;
        })();
    }
    Nimiq = await initPromise;
    return Nimiq;
}
