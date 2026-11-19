// Antigravity: T3 starts each antigravity instance on Antigravity CLI 1.5.0 or
// newer as `<cli> acp --gemini-dir <profile>`, where the profile is <T3 userdata>/providers/antigravity/<the
// SHA-256 of the instance ID> (apps/server antigravityAuthSupport.ts), and agy
// discovers a plugin at <profile>/config/plugins/<dir>. `agy plugin install`
// writes ~/.gemini whatever GEMINI_HOME says, so the installer copies the
// plugin tree into each profile itself. The older ACP runtime (1.4.x) that
// earlier T3 releases installed loads no plugins or session-start hooks.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { check, copyCheck, installCopy, readJson, SESSION_START_FILES } from "./common.mjs";

export const ANTIGRAVITY_MANIFEST = ".antigravity-plugin/plugin.json";
// The install directory, which keys Antigravity's enabled state in config.json.
const DIR = "t3-pstack";

const installPath = (home) => join(home.dir, "config", "plugins", DIR);
// agy reads the session-start hook from the plugin root's hooks.json.
const HOOK_FILES = ["hooks.json", ...SESSION_START_FILES];
// config.json wins over the manifest wherever it has an entry, and the
// manifest ships the plugin on.
const enabled = (home) => {
  const config = join(home.dir, "config", "config.json");
  return !existsSync(config) || readJson(config).plugins?.[DIR]?.enabled !== false;
};

export function installAntigravity(home, context) {
  // T3 creates the profile private, and keeps it so when it starts the instance.
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  return installCopy(installPath(home), ANTIGRAVITY_MANIFEST, HOOK_FILES, context);
}

export function doctorAntigravity(home, context) {
  const on = enabled(home);
  return [
    copyCheck(installPath(home), ANTIGRAVITY_MANIFEST, HOOK_FILES, context),
    check("enabled", on, on ? "yes" : `no, ${join(home.dir, "config", "config.json")} turns it off`, `turn t3-pstack on in that file's "plugins" map`),
  ];
}
