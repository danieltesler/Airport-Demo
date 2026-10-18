// Loads the app's own TypeScript modules (read-only) into a Node script through Vite's SSR loader,
// so scripts reuse lib/scoring.ts and lib/anchors.ts instead of re-implementing them.
import { createServer } from "vite";
import { ROOT } from "./common.mjs";

/** modulePaths: app-relative paths such as "/lib/scoring.ts". Returns { modules, close }. */
export async function loadAppModules(modulePaths) {
  const server = await createServer({
    root: ROOT, configFile: false, logLevel: "silent", server: { middlewareMode: true, hmr: false, ws: false },
    resolve: { alias: { "@": ROOT } }, appType: "custom",
  });
  try {
    const modules = [];
    for (const path of modulePaths) modules.push(await server.ssrLoadModule(path));
    return { modules, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
