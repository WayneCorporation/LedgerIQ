$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location $root
$docker='C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$desktop='C:\Program Files\Docker\Docker\Docker Desktop.exe'
if(!(Test-Path -LiteralPath $docker)){throw 'Docker Desktop is not installed'}
if(!(Test-Path -LiteralPath '.env')){
  $content=[IO.File]::ReadAllText((Join-Path $root '.env.example'))
  function Secret([int]$bytes=32){return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($bytes)).ToLowerInvariant()}
  $content=$content.Replace('replace-with-at-least-32-random-characters',(Secret)).Replace('replace-with-a-separate-32-character-secret',(Secret)).Replace('replace-with-a-strong-local-compose-password',(Secret 24))
  [IO.File]::WriteAllText((Join-Path $root '.env'),$content,[Text.UTF8Encoding]::new($false))
  Write-Host 'Created a gitignored local .env with generated development secrets.'
}
try{& $docker info *> $null}catch{Start-Process -FilePath $desktop -WindowStyle Hidden}
$ready=$false
for($attempt=0;$attempt -lt 60;$attempt++){try{& $docker info *> $null;$ready=$true;break}catch{Start-Sleep -Seconds 2}}
if(!$ready){throw 'Docker did not become ready. Confirm WSL 2 is enabled and Docker Desktop has started.'}
& $docker compose up -d postgres
for($attempt=0;$attempt -lt 30;$attempt++){$health=& $docker inspect --format '{{.State.Health.Status}}' ( & $docker compose ps -q postgres );if($health -eq 'healthy'){break};Start-Sleep -Seconds 2}
& $docker compose exec -T postgres sh -c "psql -U ledgeriq -d postgres -tc \"SELECT 1 FROM pg_database WHERE datname='ledgeriq_test'\" | grep -q 1 || psql -U ledgeriq -d postgres -c 'CREATE DATABASE ledgeriq_test'"
$env:TEST_DATABASE_URL='postgresql://ledgeriq:test-placeholder@127.0.0.1:5432/ledgeriq_test'
$password=(Get-Content -LiteralPath '.env' | Where-Object {$_ -like 'POSTGRES_PASSWORD=*'}).Substring('POSTGRES_PASSWORD='.Length)
$env:TEST_DATABASE_URL="postgresql://ledgeriq:$password@127.0.0.1:5432/ledgeriq_test"
npm test
& $docker compose build
& $docker compose up -d
& $docker compose ps
