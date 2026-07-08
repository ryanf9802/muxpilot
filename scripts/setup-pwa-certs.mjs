import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname, networkInterfaces } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const command = process.argv[2] ?? "setup";
const options = parseArgs(process.argv.slice(3));
const repoCaDir = join(repoRoot, ".certs/pwa-ca");

const caDir = resolvePath(options.caDir ?? process.env.MUXPILOT_PWA_CA_DIR ?? repoCaDir);
const certDir = resolvePath(options.certDir ?? ".certs/pwa");
const trustDir = join(certDir, "trust");
const caKeyPath = join(caDir, "rootCA-key.pem");
const caCertPath = join(caDir, "rootCA.pem");
const caSerialPath = join(caDir, "rootCA.srl");
const publicCaPemPath = join(trustDir, "muxpilot-root-ca.pem");
const publicCaCrtPath = join(trustDir, "muxpilot-root-ca.crt");
const publicCaCrlPath = join(trustDir, "muxpilot-root-ca.crl");
const mobileConfigPath = join(trustDir, "muxpilot-root-ca.mobileconfig");
const certPath = resolvePath(options.cert ?? join(certDir, "muxpilot.pem"));
const keyPath = resolvePath(options.key ?? join(certDir, "muxpilot-key.pem"));
const envLocalPath = options.envOutput ? resolvePath(options.envOutput) : join(repoRoot, ".env.local");
const csrPath = join(certDir, "muxpilot.csr");
const opensslConfigPath = join(certDir, "muxpilot-openssl.cnf");
const caOpenSslConfigPath = join(caDir, "muxpilot-ca-openssl.cnf");
const caIndexPath = join(caDir, "index.txt");
const caIndexAttrPath = join(caDir, "index.txt.attr");
const caCrlNumberPath = join(caDir, "crlnumber");
const caCrlPemPath = join(caDir, "rootCA.crl.pem");

if (command === "setup") setup();
else if (command === "trust") trust();
else if (command === "status") status();
else {
  console.error(`Unknown command: ${command}`);
  console.error("Use one of: setup, trust, status");
  process.exit(1);
}

function setup() {
  requireOpenSsl();
  ensureCa();

  const hosts = certificateHosts();
  const ips = certificateIps();
  issueHostCertificate(hosts, ips);
  generateCertificateRevocationList();
  writeTrustFiles();
  const hostTrustResults = trustHostCa();
  updateEnvLocal({
    MUXPILOT_LAN_ENABLED: "1",
    MUXPILOT_HTTPS_CERT: certPath,
    MUXPILOT_HTTPS_KEY: keyPath,
    MUXPILOT_PWA_TRUST_DIR: trustDir,
    MUXPILOT_PWA_TRUST_PORT: String(options.port ?? process.env.MUXPILOT_PWA_TRUST_PORT ?? 12880)
  });

  console.log("PWA HTTPS setup complete.");
  console.log("");
  console.log(`CA directory: ${caDir}`);
  console.log(`Host certificate: ${certPath}`);
  console.log(`Host private key: ${keyPath}`);
  console.log(`Updated: ${envLocalPath}`);
  console.log("");
  console.log("Host trust:");
  for (const result of hostTrustResults) {
    console.log(`  ${result.ok ? "ok" : "skip"} ${result.label}: ${result.message}`);
  }
  console.log("");
  console.log("Certificate names:");
  for (const host of hosts) console.log(`  DNS: ${host}`);
  for (const ip of ips) console.log(`  IP:  ${ip}`);
  console.log("");
  console.log("Next steps:");
  if (hostTrustResults.some((result) => !result.ok)) {
    console.log("  1. Review skipped host trust steps above if this browser still reports ERR_CERT_AUTHORITY_INVALID.");
    console.log("  2. Run pnpm start:prod.");
    console.log("  3. Use Connect device to install the phone certificate, then open the app URL.");
  } else {
    console.log("  1. Run pnpm start:prod.");
    console.log("  2. Use Connect device to install the phone certificate, then open the app URL.");
  }
  console.log("");
  console.log("Keep rootCA-key.pem private. Anyone with that file can issue certs trusted by your enrolled devices.");
}

function trustHostCa() {
  if (options.noHostTrust) return [{ ok: true, label: "host", message: "disabled by --no-host-trust" }];

  const results = [];
  if (isWsl()) results.push(trustWindowsCurrentUserRoot());
  else if (process.platform === "linux") results.push(trustLinuxRoot());
  else results.push({ ok: false, label: process.platform, message: "automatic host trust is not implemented for this platform" });

  if (options.requireHostTrust && results.some((result) => !result.ok)) process.exit(1);
  return results;
}

function trustWindowsCurrentUserRoot() {
  const powershell = commandPath("powershell.exe") ?? commandPath("powershell");
  const wslpath = commandPath("wslpath");
  if (!powershell || !wslpath) return { ok: false, label: "Windows CurrentUser Root", message: "powershell.exe or wslpath was not found" };

  let importPath;
  try {
    importPath = windowsImportableCaPath(powershell, wslpath);
  } catch (error) {
    return {
      ok: false,
      label: "Windows CurrentUser Root",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  if (!importPath.windowsPath) return { ok: false, label: "Windows CurrentUser Root", message: "could not prepare CA path for Windows" };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$certPath = ${powerShellString(importPath.windowsPath)}`,
    "$target = 'Cert:\\CurrentUser\\Root'",
    "$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)",
    "$existing = Get-ChildItem $target | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }",
    "if (-not $existing) { Import-Certificate -FilePath $certPath -CertStoreLocation $target | Out-Null }",
    "Write-Output $cert.Thumbprint",
    importPath.cleanupWindowsPath ? `Remove-Item -LiteralPath ${powerShellString(importPath.cleanupWindowsPath)} -Force -ErrorAction SilentlyContinue` : ""
  ].join("; ");

  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      label: "Windows CurrentUser Root",
      message: (result.stderr || result.stdout || "Import-Certificate failed").trim()
    };
  }
  return { ok: true, label: "Windows CurrentUser Root", message: `trusted ${result.stdout.trim()}` };
}

function windowsImportableCaPath(powershell, wslpath) {
  const tempResult = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "[System.IO.Path]::GetTempPath()"], {
    encoding: "utf8"
  });
  const windowsTempDir = tempResult.status === 0 ? tempResult.stdout.trim() : "";
  if (windowsTempDir) {
    const separator = windowsTempDir.endsWith("\\") || windowsTempDir.endsWith("/") ? "" : "\\";
    const windowsTempPath = `${windowsTempDir}${separator}muxpilot-root-ca-${randomUUID()}.pem`;
    const wslTempPath = spawnSync(wslpath, ["-u", windowsTempPath], { encoding: "utf8" }).stdout.trim();
    if (wslTempPath) {
      writeFileSync(wslTempPath, readFileSync(caCertPath));
      return { windowsPath: windowsTempPath, cleanupWindowsPath: windowsTempPath };
    }
  }

  const windowsCaPath = spawnSync(wslpath, ["-w", caCertPath], { encoding: "utf8" }).stdout.trim();
  return { windowsPath: windowsCaPath, cleanupWindowsPath: "" };
}

function trustLinuxRoot() {
  const updateCa = commandPath("update-ca-certificates");
  if (!updateCa) return { ok: false, label: "Linux system store", message: "update-ca-certificates was not found" };
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    return { ok: false, label: "Linux system store", message: "requires sudo/root; Windows host trust may still be enough under WSL" };
  }

  const target = "/usr/local/share/ca-certificates/muxpilot-root-ca.crt";
  try {
    writeFileSync(target, readFileSync(caCertPath));
  } catch (error) {
    return { ok: false, label: "Linux system store", message: error instanceof Error ? error.message : String(error) };
  }
  const result = spawnSync(updateCa, [], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, label: "Linux system store", message: (result.stderr || result.stdout || "update-ca-certificates failed").trim() };
  }
  return { ok: true, label: "Linux system store", message: "trusted via update-ca-certificates" };
}

function trust() {
  writeTrustFiles();

  const port = Number(options.port ?? process.env.MUXPILOT_PWA_TRUST_PORT ?? 12880);
  const host = options.listenHost ?? "0.0.0.0";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid trust server port: ${options.port}`);
    process.exit(1);
  }

  const files = new Map([
    ["/muxpilot-root-ca.pem", publicCaPemPath],
    ["/muxpilot-root-ca.crt", publicCaCrtPath],
    ["/muxpilot-root-ca.crl", publicCaCrlPath],
    ["/muxpilot-root-ca.mobileconfig", mobileConfigPath]
  ]);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(trustIndexHtml(files));
      return;
    }

    const file = files.get(url.pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    response.writeHead(200, { "content-type": contentType(file), "content-disposition": `attachment; filename="${basename(file)}"` });
    response.end(readFileSync(file));
  });

  server.on("error", (error) => {
    console.error(`Could not start trust server on ${host}:${port}: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`Serving public muxpilot root CA files from ${trustDir}`);
    console.log("Open one of these URLs on the phone, install the CA/profile, then stop this server with Ctrl+C.");
    for (const url of trustUrls(port)) console.log(`  ${url}`);
    console.log("");
    console.log("This server does not serve rootCA-key.pem.");
  });
}

function status() {
  console.log("muxpilot PWA certificate status");
  console.log("");
  console.log(`CA directory: ${caDir}`);
  console.log(`CA certificate: ${caCertPath} ${existsSync(caCertPath) ? "(exists)" : "(missing)"}`);
  console.log(`CA private key: ${caKeyPath} ${existsSync(caKeyPath) ? "(exists)" : "(missing)"}`);
  console.log(`CA revocation list: ${publicCaCrlPath} ${existsSync(publicCaCrlPath) ? "(exists)" : "(missing)"}`);
  console.log(`Host certificate: ${certPath} ${existsSync(certPath) ? "(exists)" : "(missing)"}`);
  console.log(`Host private key: ${keyPath} ${existsSync(keyPath) ? "(exists)" : "(missing)"}`);
  console.log("");
  console.log("Current LAN candidates:");
  for (const ip of lanAddresses()) console.log(`  ${ip}`);
  if (lanAddresses().length === 0) console.log("  (none detected)");

  if (existsSync(certPath)) {
    console.log("");
    runOpenSsl(["x509", "-in", certPath, "-noout", "-subject", "-issuer", "-dates", "-ext", "subjectAltName"], { inherit: true });
  }
}

function ensureCa() {
  mkdirSync(caDir, { recursive: true, mode: 0o700 });
  if (existsSync(caKeyPath) && existsSync(caCertPath) && !options.force) return;
  if ((existsSync(caKeyPath) || existsSync(caCertPath)) && !options.force) {
    console.error(`Partial CA files exist in ${caDir}. Remove them or rerun with --force.`);
    process.exit(1);
  }
  if (options.force) {
    rmSync(caKeyPath, { force: true });
    rmSync(caCertPath, { force: true });
    rmSync(caSerialPath, { force: true });
  }

  runOpenSsl(["genrsa", "-out", caKeyPath, "4096"]);
  runOpenSsl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    caKeyPath,
    "-sha256",
    "-days",
    "3650",
    "-out",
    caCertPath,
    "-subj",
    "/CN=muxpilot Local Root CA/O=muxpilot"
  ]);
  chmodPrivate(caKeyPath);
}

function issueHostCertificate(hosts, ips) {
  mkdirSync(certDir, { recursive: true });
  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(opensslConfigPath, opensslConfig(hosts, ips));
  runOpenSsl(["req", "-new", "-nodes", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", csrPath, "-config", opensslConfigPath]);
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    "825",
    "-sha256",
    "-extensions",
    "v3_req",
    "-extfile",
    opensslConfigPath
  ]);
  chmodPrivate(keyPath);
}

function writeTrustFiles() {
  if (!existsSync(caCertPath)) {
    console.error(`Missing CA certificate: ${caCertPath}. Run pnpm pwa:setup first.`);
    process.exit(1);
  }
  if (!existsSync(publicCaCrlPath)) generateCertificateRevocationList();
  mkdirSync(trustDir, { recursive: true });
  const caPem = readFileSync(caCertPath);
  writeFileSync(publicCaPemPath, caPem);
  writeFileSync(publicCaCrtPath, caPem);
  writeFileSync(mobileConfigPath, mobileConfig(caPem.toString("base64").replace(/\s+/g, "")));
}

function updateEnvLocal(values) {
  const envPath = envLocalPath;
  mkdirSync(dirname(envPath), { recursive: true });
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines
    .filter((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      if (!match) return true;
      if (!(match[1] in values)) return true;
      seen.add(match[1]);
      return false;
    })
    .filter((line, index, array) => line || index < array.length - 1);

  if (next.length && next[next.length - 1] !== "") next.push("");
  for (const [key, value] of Object.entries(values)) next.push(`${key}=${shellQuote(value)}`);
  writeFileSync(envPath, `${next.join("\n")}\n`);
}

function certificateHosts() {
  return unique(["localhost", hostname().split(".")[0], hostname(), ...optionValues("host")].filter(Boolean));
}

function certificateIps() {
  return unique(["127.0.0.1", "::1", ...lanAddresses(), ...optionValues("ip")].filter(Boolean));
}

function lanAddresses() {
  const addresses = [];
  let interfaces;
  try {
    interfaces = networkInterfaces();
  } catch {
    return [];
  }

  for (const [name, entries] of Object.entries(interfaces)) {
    if (isVirtualInterfaceName(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && usableLanAddress(entry.address)) addresses.push(entry.address);
    }
  }
  return unique(addresses).sort((a, b) => addressPriority(a) - addressPriority(b) || a.localeCompare(b, undefined, { numeric: true }));
}

function trustUrls(port) {
  return lanAddresses().map((ip) => `http://${ip}:${port}/`);
}

function opensslConfig(hosts, ips) {
  const altNames = [
    ...hosts.map((host, index) => `DNS.${index + 1} = ${host}`),
    ...ips.map((ip, index) => `IP.${index + 1} = ${ip}`)
  ].join("\n");
  const crlUrls = certificateRevocationListUrls().map((url, index) => `URI.${index + 1} = ${url}`).join("\n");

  return `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = req_distinguished_name
req_extensions = v3_req

[req_distinguished_name]
CN = muxpilot Local
O = muxpilot

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
crlDistributionPoints = @crl_urls

[alt_names]
${altNames}

[crl_urls]
${crlUrls}
`;
}

function certificateRevocationListUrls() {
  const port = Number(options.port ?? process.env.MUXPILOT_PWA_TRUST_PORT ?? 12880);
  return unique([
    `http://localhost:${port}/muxpilot-root-ca.crl`,
    `http://127.0.0.1:${port}/muxpilot-root-ca.crl`,
    ...lanAddresses().map((ip) => `http://${ip}:${port}/muxpilot-root-ca.crl`)
  ]);
}

function generateCertificateRevocationList() {
  if (!existsSync(caCertPath) || !existsSync(caKeyPath)) {
    console.error(`Missing CA files in ${caDir}. Run pnpm pwa:setup first.`);
    process.exit(1);
  }
  mkdirSync(caDir, { recursive: true, mode: 0o700 });
  mkdirSync(trustDir, { recursive: true });
  if (!existsSync(caIndexPath)) writeFileSync(caIndexPath, "");
  if (!existsSync(caIndexAttrPath)) writeFileSync(caIndexAttrPath, "unique_subject = no\n");
  if (!existsSync(caCrlNumberPath)) writeFileSync(caCrlNumberPath, "1000\n");
  writeFileSync(caOpenSslConfigPath, caOpenSslConfig());
  runOpenSsl(["ca", "-gencrl", "-config", caOpenSslConfigPath, "-out", caCrlPemPath]);
  runOpenSsl(["crl", "-in", caCrlPemPath, "-outform", "DER", "-out", publicCaCrlPath]);
}

function caOpenSslConfig() {
  return `[ca]
default_ca = CA_default

[CA_default]
dir = ${caDir}
database = ${caIndexPath}
new_certs_dir = ${caDir}
certificate = ${caCertPath}
private_key = ${caKeyPath}
serial = ${caSerialPath}
crlnumber = ${caCrlNumberPath}
default_md = sha256
default_crl_days = 30
unique_subject = no
`;
}

function mobileConfig(base64Certificate) {
  const payloadId = randomUUID().toUpperCase();
  const certId = randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>muxpilot-root-ca.pem</string>
      <key>PayloadContent</key>
      <data>${base64Certificate}</data>
      <key>PayloadDescription</key>
      <string>Installs the muxpilot local root CA.</string>
      <key>PayloadDisplayName</key>
      <string>muxpilot Local Root CA</string>
      <key>PayloadIdentifier</key>
      <string>local.muxpilot.root-ca.${certId}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${certId}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>muxpilot Local Root CA</string>
  <key>PayloadIdentifier</key>
  <string>local.muxpilot.pwa-ca.${payloadId}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${payloadId}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function trustIndexHtml(files) {
  const links = [...files.keys()].map((path) => `<li><a href="${path}">${path.slice(1)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>muxpilot CA</title></head>
<body>
  <h1>muxpilot Root CA</h1>
  <p>Install the public root CA on this device, then enable full trust if your OS requires it.</p>
  <ul>${links}</ul>
  <p>This server does not expose the CA private key.</p>
</body>
</html>
`;
}

function requireOpenSsl() {
  const result = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("openssl is required for PWA certificate setup.");
    process.exit(1);
  }
}

function runOpenSsl(args, { inherit = false } = {}) {
  const result = spawnSync("openssl", args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    console.error(`openssl ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function chmodPrivate(path) {
  try {
    statSync(path);
    spawnSync("chmod", ["600", path], { stdio: "ignore" });
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function commandPath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function isWsl() {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function powerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseArgs(args) {
  const parsed = { host: [], ip: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force" || arg === "--no-host-trust" || arg === "--require-host-trust") {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      parsed[key] = true;
    } else if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
      const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = inlineValue ?? args[++index];
      if (!value) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      if (key === "host" || key === "ip") parsed[key].push(value);
      else parsed[key] = value;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      process.exit(1);
    }
  }
  return parsed;
}

function optionValues(key) {
  const value = options[key];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function resolvePath(path) {
  if (path.startsWith("~")) return join(homedir(), path.slice(1));
  return resolve(repoRoot, path);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function contentType(file) {
  const extension = extname(file);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".mobileconfig") return "application/x-apple-aspen-config";
  if (extension === ".crl") return "application/pkix-crl";
  if (extension === ".crt" || extension === ".pem") return "application/x-pem-file";
  return "application/octet-stream";
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function usableLanAddress(address) {
  return !address.startsWith("169.254.") && !address.startsWith("127.") && address !== "0.0.0.0";
}

function addressPriority(address) {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (private172(address)) return 2;
  return 3;
}

function private172(address) {
  const [, second] = address.split(".");
  const value = Number(second);
  return address.startsWith("172.") && Number.isInteger(value) && value >= 16 && value <= 31;
}

function isVirtualInterfaceName(name) {
  const normalized = name.toLowerCase();
  return (
    normalized === "docker0" ||
    normalized.startsWith("br-") ||
    normalized.startsWith("veth") ||
    normalized.startsWith("virbr") ||
    normalized.startsWith("tailscale") ||
    normalized.startsWith("zt")
  );
}
