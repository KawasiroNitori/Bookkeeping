param(
  [int]$Port = 4177
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Endpoint = "https://script.google.com/macros/s/AKfycbwPzshs-qmMlPCsBIIW6VLUyqgkD3F3nPI96hAm7QbXigVZueCVo4a2wZlXlCwikCg/exec"
$Prefix = "http://127.0.0.1:$Port/"

function Write-Response {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [byte[]]$Bytes,
    [string]$ContentType = "text/plain; charset=utf-8",
    [int]$StatusCode = 200
  )

  $Response.StatusCode = $StatusCode
  $Response.ContentType = $ContentType
  $Response.ContentLength64 = $Bytes.Length
  $Response.Headers["Cache-Control"] = "no-store"
  $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
}

function Write-Text {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [string]$Text,
    [string]$ContentType = "text/plain; charset=utf-8",
    [int]$StatusCode = 200
  )

  Write-Response -Response $Response -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Text)) -ContentType $ContentType -StatusCode $StatusCode
}

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".css"  { "text/css; charset=utf-8" }
    ".js"   { "application/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".svg"  { "image/svg+xml" }
    ".png"  { "image/png" }
    ".jpg"  { "image/jpeg" }
    ".jpeg" { "image/jpeg" }
    ".webp" { "image/webp" }
    default { "application/octet-stream" }
  }
}

function Get-RequestBody {
  param([System.Net.HttpListenerRequest]$Request)

  $reader = [System.IO.StreamReader]::new($Request.InputStream, $Request.ContentEncoding)
  try {
    $reader.ReadToEnd()
  } finally {
    $reader.Close()
  }
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($Prefix)
$listener.Start()

Write-Host "Lab Ledger running at $Prefix"
Write-Host "Press Ctrl+C to stop."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    try {
      $path = $request.Url.AbsolutePath

      if ($path -eq "/health") {
        Write-Text -Response $response -Text '{"ok":true}' -ContentType "application/json; charset=utf-8"
        continue
      }

      if ($path -eq "/api/ledger" -and $request.HttpMethod -eq "GET") {
        $upstream = Invoke-WebRequest -Uri $Endpoint -UseBasicParsing -TimeoutSec 30
        Write-Text -Response $response -Text $upstream.Content -ContentType "application/json; charset=utf-8"
        continue
      }

      if ($path -eq "/api/save" -and $request.HttpMethod -eq "POST") {
        $body = Get-RequestBody -Request $request
        Invoke-WebRequest -Uri $Endpoint -Method POST -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 30 | Out-Null
        Write-Text -Response $response -Text '{"ok":true}' -ContentType "application/json; charset=utf-8"
        continue
      }

      if ($path.StartsWith("/api/")) {
        Write-Text -Response $response -Text '{"error":"Not found"}' -ContentType "application/json; charset=utf-8" -StatusCode 404
        continue
      }

      $relative = [System.Uri]::UnescapeDataString($path.TrimStart("/")).Replace("/", [System.IO.Path]::DirectorySeparatorChar)
      if ([string]::IsNullOrWhiteSpace($relative)) {
        $relative = "index.html"
      }

      $fullPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $relative))
      $rootPath = [System.IO.Path]::GetFullPath($Root + [System.IO.Path]::DirectorySeparatorChar)

      if (-not $fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Text -Response $response -Text "Forbidden" -StatusCode 403
        continue
      }

      if (Test-Path -LiteralPath $fullPath -PathType Container) {
        $fullPath = Join-Path $fullPath "index.html"
      }

      if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Write-Text -Response $response -Text "Not found" -StatusCode 404
        continue
      }

      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      Write-Response -Response $response -Bytes $bytes -ContentType (Get-ContentType -Path $fullPath)
    } catch {
      $message = @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
      Write-Text -Response $response -Text $message -ContentType "application/json; charset=utf-8" -StatusCode 500
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
