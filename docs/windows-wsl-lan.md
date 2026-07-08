# Windows 11 WSL2 LAN Access

muxpilot can run inside WSL2 and still be opened from a phone on the same LAN, but Windows must allow inbound traffic to the Web UI port.

In WSL mirrored networking, the app may work from Windows at `http://127.0.0.1:12778` or `http://127.0.0.1:5177` while a phone cannot open `http://<windows-lan-ip>:<port>`. That usually means Windows or the Hyper-V firewall is blocking inbound LAN traffic to WSL.

## Start muxpilot In LAN Mode

From WSL:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm run:prod
```

Production preview uses Web UI port `12778`. Development uses Web UI port `5177`:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm run:dev
```

Keep this server running while you install and verify the Windows firewall rules.

## Find The Windows Path

From Windows PowerShell, list your WSL distro names first:

```powershell
wsl.exe -l -q
```

From a WSL shell at the muxpilot repo root, print the matching Windows UNC
path:

```bash
wslpath -w "$(pwd)"
```

If you write the path manually, use the exact distro name from `wsl.exe -l -q`;
for example, `\\wsl.localhost\<distro-name>\<path-to-muxpilot>`.

## Allow Phone Access

Run PowerShell as Administrator, then use the printed WSL UNC path:

```powershell
cd '<printed-wsl-unc-path>'
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 status
```

This creates narrow inbound allow rules for TCP `12778`:

- Windows Firewall rule: `muxpilotWeb12778`
- Hyper-V firewall rule for WSL: `muxpilotWeb12778HyperV`

Only the Web UI port is exposed. The backend port stays behind the Web UI proxy.

The status output shows:

- WSL version
- `.wslconfig`
- Windows LAN IPv4 addresses
- listeners on the selected port
- muxpilot firewall rules
- connection tests for localhost and LAN IPs

The LAN IP connection test for port `12778` should report `TcpTestSucceeded : True`.

For development mode, use port `5177`:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 5177
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 status -Port 5177
```

## Verify From Your Phone

On your phone, open the URL shown by the app's Connect device dialog, usually:

```text
http://192.168.1.x:12778
```

For development mode, the URL uses port `5177`.

Do not use `localhost`, `127.0.0.1`, or `0.0.0.0` from the phone.

## QR Scanner Camera Access

Phone camera APIs require HTTPS for LAN IP URLs. If you need QR-code login from the phone, generate and trust local PWA certificates from WSL:

```bash
pnpm pwa:setup
pnpm run:prod
```

Open the Install phone certificate URL or QR code from the Connect device modal on the phone and install the public root CA/profile. The phone must trust the certificate authority. After that, the Connect device modal will publish `https://` app URLs and the QR scanner can use the camera API.

For multiple WSL host checkouts, put the shared `rootCA.pem` and `rootCA-key.pem` files in `.certs/pwa-ca/` before running `pnpm pwa:setup`. That lets your phone trust each host certificate through the same installed root CA.

`pnpm pwa:setup` also imports the root CA into the Windows current-user Trusted Root store when WSL can invoke PowerShell. If it reports that Windows host trust was skipped, run the setup command from a normal WSL terminal with Windows interop enabled and retry.

The Windows and Hyper-V firewall rules are still required for both the selected Web UI port and the trust-server port. Production preview defaults are `12778` for the Web UI and `12880` for certificate install links:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12778
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12880
```

The certificate setup handles browser trust; the firewall setup handles reachability.

## Remove Rules

Run PowerShell as Administrator:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 remove
```

For development mode rules:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 remove -Port 5177
```

The script removes only muxpilot rules that match its own rule names.

## Other Checks

- Make sure the phone is on the same WiFi/LAN as the Windows host.
- Guest WiFi networks often block device-to-device traffic.
- If the phone still cannot connect, temporarily switch the Windows network profile from Public to Private or verify that the firewall rules apply to the active profile.
