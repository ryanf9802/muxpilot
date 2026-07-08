param(
  [ValidateSet("status", "install", "remove")]
  [string]$Action = "status",

  [int]$Port = 12778
)

$ErrorActionPreference = "Stop"

$WslCreatorId = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"
$WindowsRuleName = "muxpilotWeb$Port"
$HyperVRuleName = "muxpilotWeb${Port}HyperV"
$RuleDisplayName = "muxpilot Web $Port"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin {
  if (-not (Test-IsAdmin)) {
    throw "Run this script from an elevated Administrator PowerShell for '$Action'."
  }
}

function Get-LanAddresses {
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Sort-Object IPAddress
}

function Get-WslConfig {
  $path = Join-Path $env:USERPROFILE ".wslconfig"
  if (Test-Path $path) {
    Get-Content $path
  } else {
    "(no .wslconfig found)"
  }
}

function Show-RuleStatus {
  Write-Host ""
  Write-Host "Windows Firewall rules"
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq $WindowsRuleName -or $_.DisplayName -eq $RuleDisplayName } |
    Format-Table Name,DisplayName,Direction,Action,Enabled,Profile -AutoSize

  if (Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "Hyper-V firewall rules"
    Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $HyperVRuleName -or $_.DisplayName -eq $RuleDisplayName } |
      Format-Table Name,DisplayName,Direction,Protocol,LocalPorts,Action,Enabled -AutoSize
  } else {
    Write-Host ""
    Write-Host "Hyper-V firewall cmdlets are not available on this Windows build."
  }
}

function Show-Status {
  Write-Host "muxpilot Windows/WSL LAN status"
  Write-Host ""
  Write-Host "WSL version"
  wsl.exe --version

  Write-Host ""
  Write-Host ".wslconfig"
  Get-WslConfig

  Write-Host ""
  Write-Host "Windows LAN IPv4 addresses"
  $addresses = @(Get-LanAddresses)
  $addresses | Format-Table IPAddress,InterfaceAlias,PrefixLength -AutoSize

  Write-Host ""
  Write-Host "Windows listeners for port $Port"
  netstat -ano | findstr ":$Port"

  Show-RuleStatus

  Write-Host ""
  Write-Host "Connection tests"
  Test-NetConnection -ComputerName 127.0.0.1 -Port $Port | Format-List ComputerName,RemoteAddress,RemotePort,TcpTestSucceeded
  foreach ($address in $addresses) {
    Test-NetConnection -ComputerName $address.IPAddress -Port $Port |
      Format-List ComputerName,RemoteAddress,RemotePort,InterfaceAlias,SourceAddress,TcpTestSucceeded
  }
}

function Remove-Rules {
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq $WindowsRuleName -or $_.DisplayName -eq $RuleDisplayName } |
    Remove-NetFirewallRule

  if (Get-Command Remove-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq $HyperVRuleName -or $_.DisplayName -eq $RuleDisplayName } |
      Remove-NetFirewallHyperVRule
  }
}

function Install-Rules {
  Require-Admin
  Remove-Rules

  New-NetFirewallRule `
    -Name $WindowsRuleName `
    -DisplayName $RuleDisplayName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private,Public | Out-Null

  if (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    New-NetFirewallHyperVRule `
      -Name $HyperVRuleName `
      -DisplayName $RuleDisplayName `
      -Direction Inbound `
      -VMCreatorId $WslCreatorId `
      -Protocol TCP `
      -LocalPorts $Port `
      -Action Allow | Out-Null
  }

  Write-Host "Installed muxpilot LAN firewall rules for TCP $Port."
  Show-RuleStatus
}

function Uninstall-Rules {
  Require-Admin
  Remove-Rules
  Write-Host "Removed muxpilot LAN firewall rules for TCP $Port."
}

switch ($Action) {
  "status" { Show-Status }
  "install" { Install-Rules }
  "remove" { Uninstall-Rules }
}
