// Kiro: T3 starts each kiro instance as `<config.binaryPath || kiro-cli> acp
// --agent-engine=v3 --auth-method=cli`, with the instance's environment over
// its own (packages/provider-kiro/src/server/acpSupport.ts), and Kiro reads
// its skills and hooks from $KIRO_HOME, else ~/.kiro.
import { join } from "node:path";

// POSIX single quotes, so a path with a space or a quote stays one argument.
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

// Kiro tells a hook no plugin root, so the command passes the copy's.
export const hookCommand = (root) => `sh ${quote(join(root, "hooks", "session-start.sh"))} kiro ${quote(root)}`;
