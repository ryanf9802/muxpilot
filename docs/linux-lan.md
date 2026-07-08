# Native Linux LAN Access

muxpilot can run on a native Linux desktop or laptop and be opened from a phone on the same LAN. The app must be started in LAN mode, and the Linux firewall must allow inbound traffic to the Web UI port.

## Start muxpilot In LAN Mode

Production uses Web UI port `12778`:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start
```

Development uses Web UI port `5177`:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start dev
```

You can close the terminal after startup. Leave the background server active while you install and verify the firewall rule.

## Allow Phone Access

Use the repo-local Linux helper:

```bash
scripts/linux-lan.sh install --port 12778
scripts/linux-lan.sh status --port 12778
```

The helper manages muxpilot-owned rules through `ufw` or `firewalld` when either manager is available. It does not enable or disable the firewall service itself. If neither manager is available, `status` still prints listeners, LAN addresses, and nftables/iptables diagnostics, but `install` and `remove` stop before changing low-level firewall state.

Only the selected Web UI port is exposed. The backend port stays behind the Web UI proxy.

For development mode, use port `5177`:

```bash
scripts/linux-lan.sh install --port 5177
scripts/linux-lan.sh status --port 5177
```

Preview firewall changes without applying them:

```bash
scripts/linux-lan.sh install --port 12778 --dry-run
```

## Verify From Your Phone

On your phone, open the URL shown by the app's Connect device dialog, usually:

```text
http://192.168.1.x:12778
```

For development mode, the URL uses port `5177`.

Do not use `localhost`, `127.0.0.1`, or `0.0.0.0` from the phone.

## QR Scanner Camera Access

Phone camera APIs require HTTPS for LAN IP URLs. If you need QR-code login from the phone, generate and trust local PWA certificates:

```bash
pnpm pwa:setup
pnpm app start
```

Open the Install phone certificate URL or QR code from the Connect device modal on the phone and install the public root CA/profile. The phone must trust the certificate authority. After that, the Connect device modal will publish `https://` app URLs and the QR scanner can use the camera API.

The firewall rule is still required for both the selected Web UI port and the trust-server port. Production defaults are `12778` for the Web UI and `12880` for certificate install links:

```bash
scripts/linux-lan.sh install --port 12778
scripts/linux-lan.sh install --port 12880
```

The certificate setup handles browser trust; the firewall setup handles reachability.

## Remove Rules

Remove the production Web UI rule:

```bash
scripts/linux-lan.sh remove --port 12778
```

Remove the development Web UI rule:

```bash
scripts/linux-lan.sh remove --port 5177
```

Remove the trust-server rule:

```bash
scripts/linux-lan.sh remove --port 12880
```

The script removes only muxpilot profiles/services that match its own names.

## Other Checks

- Make sure the phone is on the same WiFi/LAN as the Linux host.
- Guest WiFi networks often block device-to-device traffic.
- Run `scripts/linux-lan.sh status --port 12778` and confirm the Web UI is listening.
- If ufw or firewalld is unavailable, inspect your distro's nftables/iptables policy and manually allow inbound TCP traffic for the required muxpilot ports from your trusted LAN.
