// What the installer's harnesses share: the plugin's ids, the marketplace
// sources it trusts, the plugin copy a harness without a marketplace loads,
// the CLI runner, file writes, and the shape of a doctor check.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";

export const PLUGIN_ID = "t3-pstack@t3-pstack";
export const MARKETPLACE = "t3-pstack";
export const HOME_REPO = "chhoumann/t3-pstack";

// `~`, `~/` and `~\` expand as T3 expands them (provider-core
// pathExpansion.ts). `~user` does not.
export const expandHome = (path, home) => (path === "~" ? home : /^~[/\\]/.test(path) ? join(home, path.slice(2)) : path);

// JSON.parse's message quotes the text around the fault, which can hold a token.
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw err instanceof SyntaxError ? new Error(`${path}: invalid JSON`) : err;
  }
}

// A marketplace source as `{ key, label }`. The key is the same however the
// source is written: a GitHub repository by its lowercased `owner/repo`, a
// directory by its real path.
const GITHUB_URL = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
const github = (repo) => ({ key: `github:${repo.toLowerCase()}`, label: repo, repo });
const gitUrl = (url) => (GITHUB_URL.test(url) ? { ...github(url.match(GITHUB_URL)[1]), label: url } : { key: `git:${url}`, label: url });
const directory = (path) => ({ key: `local:${existsSync(path) ? realpathSync(path) : resolve(path)}`, label: path });

// The GitHub repository npx fetched this installer from, so a fork's own
// `npx -y github:<owner>/t3-pstack` installs from that fork with no --source.
// npx writes the spec it was given to the package.json two levels above the
// package, at <npm cache>/_npx/<hash>/node_modules/t3-pstack.
const GITHUB_SPEC = /^(?:github:)?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#.*)?$/;
export function npxOrigin(packageRoot) {
  const root = resolve(packageRoot);
  if (basename(dirname(root)) !== "node_modules") return undefined;
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8")).dependencies?.["t3-pstack"];
  } catch {
    return undefined;
  }
  return typeof spec === "string" ? spec.match(GITHUB_SPEC)?.[1] : undefined;
}

// `--source`, read as both CLIs read it: `owner/repo` is GitHub, a URL or
// `user@host:path` is Git, and anything else is a directory, which must exist.
export function parseSource(text, home) {
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(text)) return { ...github(text), arg: text };
  if (/^[a-z][a-z0-9+.-]*:\/\/|^[^/\\\s]+@[^/\\\s]+:/i.test(text)) return { ...gitUrl(text), arg: text };
  const path = resolve(expandHome(text, home));
  if (!existsSync(path)) throw new Error(`--source ${text}: not owner/repo, a Git URL, or an existing directory`);
  return { ...directory(path), arg: path, local: path };
}

// The command that reruns this install from `source`. A GitHub source is a
// copy of this repository, so its own installer converges on its version.
export function installHint(source) {
  if (source.key === github(HOME_REPO).key) return "rerun `npx -y github:chhoumann/t3-pstack install`";
  return `rerun \`npx -y github:${source.repo ?? HOME_REPO} install --source ${source.arg}\``;
}

// The sources a Claude Code home or a Codex home records for a marketplace.
// A kind the installer never adds keys to itself, so it never matches.
export function claudeSource(source) {
  if (source.source === "github") return github(source.repo);
  if (source.source === "git") return gitUrl(source.url);
  if (source.source === "directory") return directory(source.path);
  return { key: JSON.stringify(source), label: JSON.stringify(source) };
}

export function codexSource(entry) {
  if (entry.source_type === "git") return gitUrl(entry.source);
  if (entry.source_type === "local") return directory(entry.source);
  return { key: JSON.stringify(entry), label: JSON.stringify(entry) };
}

// A home installs only from a marketplace whose every source is trusted.
export const trustedOnly = (sources, trusted) => sources.length > 0 && sources.every((s) => trusted.has(s.key));

// The marketplace check both doctors run. A marketplace named t3-pstack from
// any source but the trusted ones is not installed from, nor its hook trusted.
// One from chhoumann/t3-pstack, on a run whose --source names another, is
// still installed from, and the check warns that the run did not switch it.
export function marketplaceCheck(sources, { source, trusted }, remove) {
  const hint = installHint(source);
  if (!sources.length) return check("marketplace", false, "none", hint);
  const labels = [...new Set(sources.map((s) => s.label))].join(", ");
  const foreign = sources.filter((s) => !trusted.has(s.key));
  if (foreign.length) {
    return check(
      "marketplace",
      false,
      `${labels}, which is neither ${HOME_REPO} nor --source`,
      `if you trust it, rerun with --source ${foreign[0].label}; otherwise ${remove}, then ${hint}`,
    );
  }
  const elsewhere = !sources.some((s) => s.key === source.key);
  return check(
    "marketplace",
    !elsewhere,
    elsewhere ? `${labels}, not --source ${source.label}` : labels,
    `to install from ${source.label}, ${remove}, then ${hint}`,
    elsewhere,
  );
}

// A plain copy of one of the plugin's skills: its name and its SKILL.md
// match. A user's own skill that only shares the name is theirs.
export const isPlainCopy = (name, skillFile, skills) =>
  skills.has(name) && existsSync(skillFile) && readFileSync(skillFile, "utf8") === skills.get(name);

// An install whose recorded version still has its files: the manifest and
// each skill's SKILL.md.
export const pluginIntact = (root, manifest, skills) =>
  existsSync(join(root, manifest)) && [...skills.keys()].every((name) => existsSync(join(root, "skills", name, "SKILL.md")));

// The files the session-start hook runs and reads. A copy of the plugin
// routes as released only while each matches the plugin this run installs.
export const SESSION_START_FILES = ["hooks/session-start.sh", "hooks/session-start-context.md", "skills/setup-pstack/scripts/read-sheet.sh"];

const copyVersion = (path, manifest) => (existsSync(join(path, manifest)) ? readJson(join(path, manifest)).version : undefined);
const copyWhole = (path, manifest, hookFiles, { pluginRoot, skills }) =>
  pluginIntact(path, manifest, skills) &&
  hookFiles.every((file) => existsSync(join(path, file)) && readFileSync(join(path, file)).equals(readFileSync(join(pluginRoot, file))));

export function installCopy(path, manifest, hookFiles, context) {
  const { pluginRoot, version } = context;
  const before = copyVersion(path, manifest);
  if (before === version && copyWhole(path, manifest, hookFiles, context)) return [];
  mkdirSync(dirname(path), { recursive: true });
  // A whole tree swapped in by rename, so a session never loads half a plugin
  // and files a release dropped do not linger.
  const fresh = tempBeside(path);
  cpSync(pluginRoot, fresh, { recursive: true });
  const old = existsSync(path) ? tempBeside(path) : undefined;
  if (old) renameSync(path, old);
  renameSync(fresh, path);
  if (old) rmSync(old, { recursive: true, force: true });
  return [before === undefined ? `installed ${version}` : before === version ? `reinstalled ${version}, whose files were missing or changed` : `updated ${before} to ${version}`];
}

export function copyCheck(path, manifest, hookFiles, context) {
  const { version, hint } = context;
  const installed = copyVersion(path, manifest);
  const whole = copyWhole(path, manifest, hookFiles, context);
  return check(
    "installed",
    installed === version && whole,
    !installed ? "not installed" : installed !== version ? `${installed}, expected ${version}` : whole ? installed : `${installed}, but its files at ${path} are missing or changed`,
    hint,
  );
}

// Every CLI runs from an empty directory. Claude Code reads `<cwd>/.claude`
// as project settings, and from the home folder that is the main home's
// settings.json, so the user's own working directory could leak into the
// home being installed.
let neutral;
export function neutralCwd() {
  if (!neutral) {
    neutral = mkdtempSync(join(tmpdir(), "t3-pstack-"));
    process.on("exit", () => rmSync(neutral, { recursive: true, force: true }));
  }
  return neutral;
}

// The file `bin` runs: `bin` itself when it is a path, else its first match
// on PATH. Windows, like cmd.exe, tries PATHEXT's extensions on a name that
// has none, and so skips the extensionless sh script npm installs beside a
// .cmd shim.
export function resolveCli(bin) {
  if (basename(bin) !== bin) return existsSync(bin) ? bin : undefined;
  const extensions = process.platform === "win32" && !extname(bin) ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of extensions) {
      if (dir && existsSync(join(dir, bin + ext))) return join(dir, bin + ext);
    }
  }
}

// Looked up rather than run: `codex --version` already writes into the
// default CODEX_HOME.
export const hasCli = (bin) => resolveCli(bin) !== undefined;

// cmd.exe's line for a .cmd or .bat file, as cross-spawn builds it. Each
// argument is quoted for the program's own parser, then every cmd.exe
// metacharacter is escaped twice: once for `cmd /c`, and once for the line in
// the script, such as npm's shim, that passes `%*` on.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdLine(file, args) {
  const quote = (arg) =>
    `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
  return [file.replace(CMD_META, "^$1"), ...args.map(quote)].join(" ");
}

// How to start `bin`. Node starts a .cmd or .bat file only through cmd.exe,
// and an npm-installed `claude` or `codex` on Windows is one.
export function launch(bin, args) {
  const file = resolveCli(bin) ?? bin;
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args, options: {} };
  return {
    file: process.env.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${cmdLine(file, args)}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function runCli(bin, args, env) {
  const run = launch(bin, args);
  try {
    return execFileSync(run.file, run.args, {
      ...run.options,
      cwd: neutralCwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (err) {
    throw new Error(`${bin} ${args.join(" ")}: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
}

// A path beside `path` that nothing holds. Creating it with the `wx` flag or
// symlinkSync fails rather than replace a file someone else put there.
export const tempBeside = (path) => join(dirname(path), `.${basename(path)}.${randomUUID()}.t3-pstack.tmp`);

// A crash between the write and the rename leaves the old file whole. The
// rename lands on the symlink's target, so a settings file one home links
// from another stays shared. The new file takes the mode and, where the
// system allows, the owner of the file it replaces, or of `like`.
export function writeAtomic(path, text, like = path) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = tempBeside(target);
  writeFileSync(tmp, text, { flag: "wx" });
  const old = statSync(like, { throwIfNoEntry: false });
  if (old) {
    chmodSync(tmp, old.mode & 0o7777);
    try {
      chownSync(tmp, old.uid, old.gid);
    } catch (err) {
      if (err.code !== "EPERM") throw err;
    }
  }
  renameSync(tmp, target);
}

// An update step. A marketplace behind the installer, such as main before a
// release merges, leaves the version where it was.
export const updated = (from, to, version) => (from === to ? `the marketplace has no ${version}, so it stays at ${to}` : `updated ${from} to ${to}`);

// A doctor check. `warn` marks one that never fails the run.
export const check = (name, ok, detail, fix, warn = false) => ({ name, ok, detail, ...(ok ? {} : { fix }), ...(warn && { warn }) });
