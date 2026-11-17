[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -CommandType Application

# Check the same address the website binds, before asking for a password.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3211)
try {
    $listener.Start()
} catch [System.Net.Sockets.SocketException] {
    throw 'Port 3211 is unavailable. If the website is already running, open http://127.0.0.1:3211/.'
} finally {
    $listener.Stop()
}

$settings = @{
    PORT = '3211'
    MAPLE_DATABASE_NAMESPACE = 'maple-trial-01'
    MAPLE_ENABLE_SCHEDULE = '0'
}
$previous = @{}
foreach ($name in @($settings.Keys) + 'MAPLE_DATABASE_URL') {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$password = Read-Host 'Enter the PostgreSQL password for maple_app' -AsSecureString
if (-not $password.Length) { throw 'The database password is required.' }

Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    $credential = [pscredential]::new('maple_app', $password)
    $encodedPassword = [uri]::EscapeDataString($credential.GetNetworkCredential().Password)
    $env:MAPLE_DATABASE_URL = "postgresql://maple_app:${encodedPassword}@127.0.0.1:5433/maple_native"
    Remove-Variable encodedPassword, credential

    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
    }

    & $node.Source --env-file-if-exists=.env src/start.mjs
    if ($LASTEXITCODE -ne 0) { throw "The website exited with code $LASTEXITCODE." }
} finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    $password.Dispose()
    Pop-Location
}
