$ErrorActionPreference = "Stop"

# BRODSKY: Recreate PostgreSQL DB with UTF8 (DEV ONLY!)
# DANGER: This will DESTROY ALL DATA in the target database.
#
# What it does:
# 1) Terminates active connections to DB
# 2) Drops the database
# 3) Recreates it with ENCODING UTF8 using TEMPLATE template0
# 4) Reinstalls deps (npm install)
# 5) Runs Prisma migrations (deploy) + generate
# 6) Verifies UTF8 by inserting Russian text via Prisma (then deletes it)

$projectRoot = "E:\pro vkr"
$dbName = "brodsky"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  Write-Host $Label -ForegroundColor Yellow
  & $Command
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    throw "Command failed (exit code $LASTEXITCODE): $Label"
  }
}

Write-Host "== BRODSKY DB recreate (UTF8) ==" -ForegroundColor Cyan
Write-Host "Project: $projectRoot"
Write-Host "Database: $dbName"
Write-Host ""

Set-Location $projectRoot

# Try to locate psql.exe if it's not in PATH
$psql = (Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
if (-not $psql) {
  $psql = (Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter psql.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bin\\psql\.exe$" } |
    Select-Object -First 1 -ExpandProperty FullName)
}
if (-not $psql) {
  throw "psql.exe not found. Install PostgreSQL client tools or add psql to PATH."
}
Write-Host "Using psql: $psql"

Invoke-Checked "1) Terminate connections + drop DB..." { $psql -v ON_ERROR_STOP=1 -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$dbName' AND pid <> pg_backend_pid();" }
Invoke-Checked "   Drop database..." { $psql -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS $dbName;" }

Invoke-Checked "2) Create DB with UTF8 (template0)..." { $psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $dbName WITH ENCODING 'UTF8' TEMPLATE template0;" }

Invoke-Checked "3) Confirm server_encoding..." { $psql -v ON_ERROR_STOP=1 -d $dbName -c "SHOW server_encoding;" }

Invoke-Checked "4) Install dependencies (npm install)..." { npm install }

Invoke-Checked "5) Run Prisma migrations (deploy)..." { npx prisma migrate deploy --schema prisma/schema.prisma }
Invoke-Checked "   Generate Prisma client..." { npx prisma generate --schema prisma/schema.prisma }

Invoke-Checked "6) UTF8 verification insert (Russian text)..." { node "scripts\utf8-prisma-test.js" }

Write-Host ""
Write-Host "DONE. DB recreated with UTF8 and verified." -ForegroundColor Green

