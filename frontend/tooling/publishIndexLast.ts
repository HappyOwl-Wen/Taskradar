import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Plugin } from "vite";

/** Publish the HTML entry only after all of its hashed scripts/styles have reached disk. */
export function publishIndexLast(): Plugin {
  let indexPath = "";
  let html: string | Uint8Array | undefined;
  return {
    name: "taskradar-publish-index-last",
    apply: "build",
    enforce: "post",
    configResolved(config) { indexPath = resolve(config.root, config.build.outDir, "index.html"); },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset") throw new Error("TaskRadar build is missing index.html");
        html = index.source;
        delete bundle["index.html"];
      },
    },
    writeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (html === undefined) throw new Error("TaskRadar HTML was not generated");
        const temporary = `${indexPath}.${process.pid}.next`;
        try {
          await writeFile(temporary, html);
          for (let attempt = 0; ; attempt++) {
            try { await rename(temporary, indexPath); break; }
            catch (error) {
              // Windows may briefly hold the previous HTML open while a local request reads it.
              if (attempt >= 4 || !(error instanceof Error) || !("code" in error) || !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))) throw error;
              await setTimeout(25 * (attempt + 1));
            }
          }
        } finally { await rm(temporary, { force: true }); }
      },
    },
  };
}
