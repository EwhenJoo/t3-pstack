// Kiro: T3 starts each kiro instance as `<config.binaryPath || kiro-cli> acp
// --agent-engine=v3 --auth-method=cli`, with the instance's environment over
// its own (packages/provider-kiro/src/server/acpSupport.ts), and Kiro reads
// its skills and hooks from $KIRO_HOME, else ~/.kiro. It loads a skill from
// <home>/skills/<name> and a hook from any file in <home>/hooks, so the
// installer keeps a copy of the plugin at <home>/t3-pstack, links each skill
// into it, and writes a hooks file that runs the copy's session-start hook.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { check, copyCheck, foreignCopy, installCopy, isPlainCopy, SESSION_START_FILES, tempBeside, writeAtomic } from "./common.mjs";

const MANIFEST = ".claude-plugin/plugin.json";
const copyPath = (home) => join(home.dir, "t3-pstack");
const hooksPath = (home) => join(home.dir, "hooks", "t3-pstack.json");
const readHooks = (home) => (existsSync(hooksPath(home)) ? readFileSync(hooksPath(home), "utf8") : undefined);

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

// Kiro tells a hook no plugin root, so the command passes the copy's.
export const hookCommand = (root) => `sh ${quote(join(root, "hooks", "session-start.sh"))} kiro ${quote(root)}`;

// Kiro adds a PostCompact hook's output after compaction, so the routing
// text outlives it.
export const hooksFile = (root) =>
  JSON.stringify(
    {
      version: "v1",
      hooks: ["SessionStart", "PostCompact"].map((trigger) => ({
        name: "t3-pstack",
        trigger,
        timeout: 10,
        action: { type: "command", command: hookCommand(root) },
      })),
    },
    null,
    2,
  ) + "\n";

const real = (path) => (existsSync(path) ? realpathSync(path) : path);
const inside = (path, dir) => path.startsWith(dir + sep);

// A home reached through a symlink may have linked into the copy by its real path.
function classify(path, name, root, skills) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { kind: "missing" };
  if (!stat.isSymbolicLink()) return { kind: isPlainCopy(name, join(path, "SKILL.md"), skills) ? "copy" : "own" };
  const linked = resolve(dirname(path), readlinkSync(path));
  return { kind: inside(linked, root) || inside(real(path), real(root)) ? "ours" : "link", linked };
}

// Kiro has no skill namespace, so an entry of the same name that t3-pstack
// did not make keeps the plugin's skill from loading.
const COLLISIONS = {
  own: { kind: "your own skill", fix: "rename your skill" },
  copy: { kind: "a plain copy of t3-pstack's skill", fix: "delete the copy" },
  link: { kind: "a link into another checkout", fix: "remove the link" },
};

function skillPlan(home, skills) {
  const dir = join(home.dir, "skills");
  const root = join(copyPath(home), "skills");
  const names = new Set([...skills.keys(), ...(existsSync(dir) ? readdirSync(dir) : [])]);
  const entries = [...names].map((name) => ({
    name,
    path: join(dir, name),
    target: join(root, name),
    shipped: skills.has(name),
    ...classify(join(dir, name), name, root, skills),
  }));
  return {
    link: entries.filter((e) => e.shipped && e.kind === "missing"),
    repoint: entries.filter((e) => e.shipped && e.kind === "ours" && e.linked !== e.target),
    unlink: entries.filter((e) => !e.shipped && e.kind === "ours"),
    collisions: entries.filter((e) => e.shipped && e.kind in COLLISIONS),
  };
}

const names = (entries) => entries.map((e) => e.name).join(", ");

// "junction" lets Windows link a directory without the symlink privilege.
// The link is made beside its path and renamed in, so it is never missing.
function link(target, path) {
  const fresh = tempBeside(path);
  symlinkSync(target, fresh, "junction");
  renameSync(fresh, path);
}

function linkSkills(home, skills) {
  const plan = skillPlan(home, skills);
  mkdirSync(join(home.dir, "skills"), { recursive: true });
  for (const entry of [...plan.link, ...plan.repoint]) link(entry.target, entry.path);
  for (const entry of plan.unlink) unlinkSync(entry.path);
  return [
    plan.link.length && `linked ${plan.link.length} skill${plan.link.length === 1 ? "" : "s"}`,
    plan.repoint.length && `repointed ${names(plan.repoint)} at the copy`,
    plan.unlink.length && `unlinked ${names(plan.unlink)}, which this release dropped`,
  ].filter(Boolean);
}

function writeHooks(home) {
  const before = readHooks(home);
  const text = hooksFile(copyPath(home));
  if (before === text) return [];
  mkdirSync(dirname(hooksPath(home)), { recursive: true });
  writeAtomic(hooksPath(home), text);
  return [before === undefined ? `wrote ${hooksPath(home)}` : `rewrote ${hooksPath(home)}, which had changed`];
}

export function installKiro(home, context) {
  // Kiro creates its home private.
  mkdirSync(home.dir, { recursive: true, mode: 0o700 });
  // The links and the hooks file point into the copy, so neither goes in
  // while another tree holds its path.
  if (foreignCopy(copyPath(home), MANIFEST)) return [];
  return [...installCopy(copyPath(home), MANIFEST, SESSION_START_FILES, context), ...linkSkills(home, context.skills), ...writeHooks(home)];
}

function skillsCheck({ link, repoint, unlink, collisions }, skills, hint) {
  const faults = [
    link.length && `not linked: ${names(link)}`,
    repoint.length && `linked to the wrong target: ${names(repoint)}`,
    unlink.length && `linked but dropped from this release: ${names(unlink)}`,
  ].filter(Boolean);
  return check("skills", !faults.length, faults.join("; ") || `${skills.size - collisions.length} linked`, hint);
}

const collisionCheck = ({ name, path, kind, linked }, hint) =>
  check(
    `skill ${name}`,
    false,
    `${path} is ${COLLISIONS[kind].kind}${linked ? `, ${linked}` : ""}, so t3-pstack's ${name} cannot load`,
    `${COLLISIONS[kind].fix}, then ${hint}`,
  );

function hookCheck(home, hint) {
  const text = readHooks(home);
  const ok = text === hooksFile(copyPath(home));
  const path = hooksPath(home);
  return check("hook", ok, ok ? path : text === undefined ? `${path} is missing` : `${path} is not the file this release writes`, hint);
}

export function doctorKiro(home, context) {
  if (foreignCopy(copyPath(home), MANIFEST)) return [copyCheck(copyPath(home), MANIFEST, SESSION_START_FILES, context)];
  const plan = skillPlan(home, context.skills);
  return [
    copyCheck(copyPath(home), MANIFEST, SESSION_START_FILES, context),
    skillsCheck(plan, context.skills, context.hint),
    ...plan.collisions.map((entry) => collisionCheck(entry, context.hint)),
    hookCheck(home, context.hint),
  ];
}
