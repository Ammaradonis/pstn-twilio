# Render the two Facebook comment prompts (and optionally call DeepSeek),
# from anywhere in the repo, with the worker's own virtualenv.
#
#   .\workers\email-finder\fb-comment.ps1 --post tmp\post.txt --market UK `
#       --group "Martial Arts Instructors UK" --fact "we ring our own line at 6:40pm"
#
# Every argument is passed straight through to email_finder.fb_prompts.
$ErrorActionPreference = 'Stop'

$worker = $PSScriptRoot
$python = Join-Path $worker '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw "No Python found: expected $worker\.venv\Scripts\python.exe" }
    Write-Warning "Using $python; the worker venv is missing so imports may fail."
}
$env:PYTHONPATH = $worker
& $python -m email_finder.fb_prompts @args
exit $LASTEXITCODE
