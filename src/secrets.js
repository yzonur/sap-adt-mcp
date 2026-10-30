// Secret resolution for config values (passwords, certificate passphrases,
// bearer tokens) and the `set-password` CLI that stores them.
//
// A secret field accepts:
//   "plain text"          used verbatim (discouraged outside throwaway setups)
//   "env:VAR"             read from an environment variable
//   "keychain:<account>"  OS keychain — macOS Keychain (`security`) or the Linux
//                         Secret Service (`secret-tool`); service "sap-adt-mcp"
//   "dpapi:<base64>"      Windows DPAPI blob, decryptable only by the same
//                         Windows user (ProtectedData, CurrentUser scope)
//
// No runtime dependency: everything shells out to the OS tool with
// execFileSync and an argv array — never through a shell string — and the
// secret itself always travels over stdin/stdout, never on a command line.

import {
  execFileSync as nodeExecFileSync,
  spawnSync as nodeSpawnSync,
} from "node:child_process";

export const KEYCHAIN_SERVICE = "sap-adt-mcp";

// Test seams: the unit tests swap in fakes so no real keychain is touched.
let execFileSync = nodeExecFileSync;
let spawnSync = nodeSpawnSync;
export function setExecFileSyncForTests(fn) {
  execFileSync = fn ?? nodeExecFileSync;
}
export function setSpawnSyncForTests(fn) {
  spawnSync = fn ?? nodeSpawnSync;
}

// PowerShell snippets exchange base64 over stdin/stdout so non-ASCII secrets
// survive the console code page untouched.
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";
const PS_PROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";

export function resolveSecret(value, label, { platform = process.platform } = {}) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.startsWith("env:")) {
    const varName = value.slice(4);
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(`${label}: env var ${varName} is not set`);
    }
    return resolved;
  }
  if (value.startsWith("keychain:")) {
    const account = value.slice("keychain:".length);
    if (!account) throw new Error(`${label}: "keychain:" needs an account name, e.g. "keychain:DEV"`);
    return readKeychain(account, label, platform);
  }
  if (value.startsWith("dpapi:")) {
    return readDpapi(value.slice("dpapi:".length), label, platform);
  }
  return value;
}

function readKeychain(account, label, platform) {
  if (platform === "darwin") return readMacKeychain(account, label);
  let tool;
  let argv;
  if (platform === "linux") {
    tool = "secret-tool";
    argv = ["lookup", "service", KEYCHAIN_SERVICE, "account", account];
  } else {
    throw new Error(
      `${label}: "keychain:" is supported on macOS and Linux. On Windows use a "dpapi:" ` +
        `value — run \`sap-adt-mcp set-password <SYSTEM>\` to create one.`
    );
  }
  let out;
  try {
    out = execFileSync(tool, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `${label}: "${tool}" was not found` +
          (platform === "linux" ? " — install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch)." : "."),
        { cause: err }
      );
    }
    throw new Error(
      `${label}: no keychain entry for service "${KEYCHAIN_SERVICE}", account "${account}". ` +
        `Store it with \`sap-adt-mcp set-password ${account}\`.`,
      { cause: err }
    );
  }
  return nonEmpty(String(out).replace(/\r?\n$/, ""), account, label);
}

// `security ... -w` prints a non-ASCII password as bare hex, indistinguishable
// from an ASCII password that happens to be hex. `-g` writes an unambiguous
// line to stderr instead:  password: "ascii"  |  password: 0x<HEX>  "<escaped>"
function readMacKeychain(account, label) {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-g"],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }
  );
  if (r.error) {
    throw new Error(`${label}: "security" was not found.`, { cause: r.error });
  }
  if (r.status !== 0) {
    throw new Error(
      `${label}: no keychain entry for service "${KEYCHAIN_SERVICE}", account "${account}". ` +
        `Store it with \`sap-adt-mcp set-password ${account}\`.`
    );
  }
  const line = String(r.stderr).split(/\r?\n/).find((l) => l.startsWith("password:")) ?? "";
  const hex = line.match(/^password: 0x([0-9A-Fa-f]+)/);
  if (hex) return nonEmpty(Buffer.from(hex[1], "hex").toString("utf8"), account, label);
  const quoted = line.match(/^password: "(.*)"$/);
  return nonEmpty(quoted ? quoted[1] : "", account, label);
}

function nonEmpty(secret, account, label) {
  if (!secret) {
    throw new Error(`${label}: keychain entry "${account}" is empty`);
  }
  return secret;
}

function readDpapi(blob, label, platform) {
  if (platform !== "win32") {
    throw new Error(`${label}: "dpapi:" values can only be decrypted on Windows, by the user that created them.`);
  }
  if (!blob) throw new Error(`${label}: "dpapi:" value is empty`);
  let out;
  try {
    out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT],
      { input: blob, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {
    throw new Error(
      `${label}: DPAPI decryption failed. The value must be created by the same Windows ` +
        `user on this machine — re-run \`sap-adt-mcp set-password <SYSTEM>\`.`
    );
  }
  return Buffer.from(String(out).trim(), "base64").toString("utf8");
}

// Store a secret and return the config value that resolves it.
export function storeSecret(account, secret, { platform = process.platform } = {}) {
  if (platform === "darwin") {
    // `security` has no stdin mode for -w; a value given here lands on its argv.
    // The CLI avoids that by letting `security` prompt itself (see setPasswordCli).
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-l", `sap-adt-mcp ${account}`, "-w", secret],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    return `keychain:${account}`;
  }
  if (platform === "linux") {
    execFileSync(
      "secret-tool",
      ["store", `--label=sap-adt-mcp ${account}`, "service", KEYCHAIN_SERVICE, "account", account],
      { input: secret, stdio: ["pipe", "ignore", "pipe"] }
    );
    return `keychain:${account}`;
  }
  if (platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT],
      { input: Buffer.from(secret, "utf8").toString("base64"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return `dpapi:${String(out).trim()}`;
  }
  throw new Error(`set-password is not supported on platform "${platform}".`);
}

// Read a line from the TTY without echoing it.
export function readHidden(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      // Piped input (CI, scripts): read it all, use the first line.
      let data = "";
      input.setEncoding("utf8");
      input.on("data", (c) => (data += c));
      input.on("end", () => resolve(data.split(/\r?\n/)[0]));
      input.on("error", reject);
      return;
    }
    output.write(prompt);
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
  });
}

// `sap-adt-mcp set-password <SYSTEM>` — prompt (no echo), store, print the
// config line. The account name is the system name.
export async function setPasswordCli(argv, { out = process.stdout, err = process.stderr, platform = process.platform } = {}) {
  const account = argv[0];
  if (!account || account.startsWith("-")) {
    err.write("Usage: sap-adt-mcp set-password <SYSTEM>\n");
    return 2;
  }
  try {
    if (platform === "darwin" && process.stdin.isTTY) {
      // `-w` as the last option makes `security` prompt (twice, no echo) on the
      // TTY itself, so the secret never appears in a process argv.
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-l", `sap-adt-mcp ${account}`, "-w"],
        { stdio: "inherit" }
      );
      printRef(out, account, `keychain:${account}`);
      return 0;
    }
    const secret = await readHidden(`Secret for ${account} (input hidden): `);
    if (!secret) {
      err.write("Empty secret — nothing stored.\n");
      return 2;
    }
    if (process.stdin.isTTY) {
      const again = await readHidden("Repeat: ");
      if (again !== secret) {
        err.write("Values do not match — nothing stored.\n");
        return 2;
      }
    }
    printRef(out, account, storeSecret(account, secret, { platform }));
    return 0;
  } catch (e) {
    err.write(`set-password failed: ${e.code === "ENOENT" ? "the OS secret tool was not found" : e.message}\n`);
    return 1;
  }
}

function printRef(out, account, ref) {
  out.write(
    `Stored. Use this in ~/.sap-adt-mcp/config.json for system ${account}:\n\n` +
      `  "password": "${ref}"\n\n` +
      `(or as "passphrase" / "token" inside an "auth" block).\n`
  );
}
