# Checks the real Supabase Storage bucket end to end from this computer (npm run storage:check):
# writes one small probe file under attachments/, reads it back, compares it and deletes it.
# The access keys are typed here (the secret is masked), held only in this window's process
# environment, and never written to disk or printed. Needs no database settings and touches no database.
# Run from stslv-api:  powershell -ExecutionPolicy Bypass -File scripts\check-supabase-storage.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$ref = Read-Host "Supabase project reference [sgzvlmjkhhrwtuuqatve]"
if (-not $ref) { $ref = "sgzvlmjkhhrwtuuqatve" }
$bucket = Read-Host "Bucket [stslv-amc-documents]"
if (-not $bucket) { $bucket = "stslv-amc-documents" }
$region = Read-Host "Region (from Storage > S3 Connection, e.g. eu-central-1)"

$env:SUPABASE_PROJECT_REF = $ref.Trim()
$env:SUPABASE_S3_BUCKET = $bucket.Trim()
$env:SUPABASE_S3_REGION = $region.Trim()
$env:SUPABASE_S3_ACCESS_KEY_ID = (Read-Secret "Access key ID").Trim()
$env:SUPABASE_S3_SECRET_ACCESS_KEY = (Read-Secret "Secret access key").Trim()
# The check reads only the storage settings: no database, DB_* or JWT_SECRET is needed or used.
# Production rules apply (https endpoint only).
$env:NODE_ENV = "production"
# Do not let a local .env, or this window, add another store's settings.
$env:DOTENV_CONFIG_PATH = "NUL"
foreach ($name in "ATTACHMENTS_DIR", "SUPABASE_S3_ENDPOINT", "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT") {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

try {
  npm run --silent storage:check
} finally {
  Remove-Item Env:SUPABASE_S3_ACCESS_KEY_ID, Env:SUPABASE_S3_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
  [GC]::Collect()
}
Read-Host "Press Enter to close"
