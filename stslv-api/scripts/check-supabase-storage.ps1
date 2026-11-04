# Checks the real Supabase Storage bucket end to end from this computer (npm run storage:check):
# writes one small probe file under attachments/, reads it back, compares it and deletes it.
# The access keys are typed here (the secret is masked), held only in this window's process
# environment, and never written to disk or printed. Touches no database.
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
# The check script needs no database and no real session secret.
$env:JWT_SECRET = -join ((1..48) | ForEach-Object { [char](Get-Random -Minimum 97 -Maximum 123) })
$env:NODE_ENV = "production"
# Do not let a local .env add ATTACHMENTS_DIR or other storage settings.
$env:DOTENV_CONFIG_PATH = "NUL"
$env:ATTACHMENTS_DIR = ""

try {
  npm run --silent storage:check
} finally {
  Remove-Item Env:SUPABASE_S3_ACCESS_KEY_ID, Env:SUPABASE_S3_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
}
Read-Host "Press Enter to close"
