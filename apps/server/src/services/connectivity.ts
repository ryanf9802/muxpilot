import { networkInterfaces } from "node:os";
import type { ConnectivityResponse, RemoteAccessResponse } from "@muxpilot/core";
import type { AppConfig } from "../config/config.js";
import { isLoopbackBindHost, requiresOperatorToken } from "../config/config.js";

export function buildConnectivity(config: AppConfig, detectedLanAddresses = detectLanAddresses(), unrestrictedRemoteAccess = false): ConnectivityResponse {
  const lanAddresses = sortLanAddresses(Array.from(new Set(detectedLanAddresses)));
  const lanBound = !isLoopbackBindHost(config.host);
  const accessMode = unrestrictedRemoteAccess ? "unrestricted" : requiresOperatorToken(config) ? "token" : "local";
  const candidateHosts = bindHosts(config.host, lanAddresses);
  const urls = lanBound ? candidateHosts.map((host) => `${config.webProtocol}://${host}:${config.webPort}`) : [];
  const warnings: string[] = [];

  if (!lanBound) {
    warnings.push("Backend and web UI are bound to loopback. Restart with MUXPILOT_LAN_ENABLED=1 for phone access.");
  }
  if (lanBound && lanAddresses.length === 0) {
    warnings.push("No non-loopback IPv4 address was detected on this host.");
  }

  return {
    bindHost: config.host,
    webProtocol: config.webProtocol,
    backendPort: config.port,
    webPort: config.webPort,
    accessMode,
    accessKeyRequired: accessMode === "token",
    unrestrictedRemoteAccess,
    phoneAccessAvailable: urls.length > 0,
    primaryUrl: urls[0] ?? null,
    urls,
    lanAddresses,
    warnings
  };
}

export function buildRemoteAccess(
  config: AppConfig,
  accessKey: string,
  detectedLanAddresses = detectLanAddresses(),
  unrestrictedRemoteAccess = false
): RemoteAccessResponse {
  const connectivity = buildConnectivity(config, detectedLanAddresses, unrestrictedRemoteAccess);
  const accessUrls = unrestrictedRemoteAccess
    ? connectivity.urls
    : connectivity.urls.map((url) => {
        const accessUrl = new URL("/access", url);
        accessUrl.searchParams.set("accessKey", accessKey);
        return accessUrl.toString();
      });

  return {
    ...connectivity,
    accessKey,
    primaryAccessUrl: accessUrls[0] ?? null,
    accessUrls,
    pwaTrust: buildPwaTrust(config, connectivity.lanAddresses)
  };
}

function buildPwaTrust(config: AppConfig, lanAddresses: string[]) {
  const warnings: string[] = [];
  if (!config.pwaTrustDir) warnings.push("PWA trust files are not configured. Run pnpm pwa:setup.");
  if (lanAddresses.length === 0) warnings.push("No non-loopback IPv4 address was detected for PWA trust setup.");

  const urls = config.pwaTrustDir
    ? lanAddresses.map((address) => `http://${address}:${config.pwaTrustPort}/muxpilot-root-ca.crt`)
    : [];

  return {
    available: urls.length > 0,
    port: config.pwaTrustDir ? config.pwaTrustPort : null,
    primaryUrl: urls[0] ?? null,
    urls,
    warnings
  };
}

function detectLanAddresses(): string[] {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (isVirtualInterfaceName(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isUsableLanAddress(entry.address)) addresses.push(entry.address);
    }
  }
  return sortLanAddresses(Array.from(new Set(addresses)));
}

function bindHosts(host: string, lanAddresses: string[]): string[] {
  const normalized = host.trim();
  if (normalized === "0.0.0.0" || normalized === "::") return lanAddresses;
  if (isLoopbackBindHost(normalized)) return [];
  return [normalized];
}

function sortLanAddresses(addresses: string[]): string[] {
  return [...addresses].sort((a, b) => addressPriority(a) - addressPriority(b) || a.localeCompare(b, undefined, { numeric: true }));
}

function addressPriority(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  if (isPrivate172Address(address)) return 2;
  return 3;
}

function isUsableLanAddress(address: string): boolean {
  return !address.startsWith("169.254.") && !address.startsWith("127.") && address !== "0.0.0.0";
}

function isPrivate172Address(address: string): boolean {
  const [, second] = address.split(".");
  const value = Number(second);
  return address.startsWith("172.") && Number.isInteger(value) && value >= 16 && value <= 31;
}

function isVirtualInterfaceName(name: string): boolean {
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
