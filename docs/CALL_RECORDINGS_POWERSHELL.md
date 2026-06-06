# Retrieve Call Recordings With PowerShell

Run these commands from the repository root. They expect `.env` to contain `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `DATABASE_URL`.

To hear recordings in the web app, use the Calls page for the number and click `Play` in the `Recordings` column. The app fetches the MP3 through the authenticated API; you do not need to expose your Twilio auth token in the browser or download files locally.

The commands below are for diagnostics.

## Load Environment Variables

```powershell
Get-Content .env | Where-Object { $_ -match '^\s*[^#][^=]*=' } | ForEach-Object {
  $Name, $Value = $_ -split '=', 2
  Set-Item -Path "Env:$($Name.Trim())" -Value ($Value.Trim().Trim('"').Trim("'"))
}

$Auth = [Convert]::ToBase64String(
  [Text.Encoding]::ASCII.GetBytes("$($env:TWILIO_ACCOUNT_SID):$($env:TWILIO_AUTH_TOKEN)")
)
$Headers = @{ Authorization = "Basic $Auth" }
$TwilioBase = "https://api.twilio.com/2010-04-01/Accounts/$($env:TWILIO_ACCOUNT_SID)"
```

## Download Recordings By Twilio Call SID

Replace `$CallSid` with a real Twilio call SID from the call log. A value like `CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` is only a placeholder and will return Twilio error `20404`.

```powershell
$CallSid = "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$OutDir = ".\recordings\$CallSid"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Response = Invoke-RestMethod -Headers $Headers -Uri "$TwilioBase/Calls/$CallSid/Recordings.json"
$Response.recordings | Select-Object sid, status, duration, channels, source, uri

foreach ($Recording in $Response.recordings) {
  $RecordingSid = $Recording.sid
  Invoke-WebRequest `
    -Headers $Headers `
    -Uri "$TwilioBase/Recordings/$RecordingSid.mp3" `
    -OutFile "$OutDir\$RecordingSid.mp3"
}
```

## Query Stored Recording Rows From The Database

```powershell
$CallSid = "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$QueryScript = @'
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const callSid = process.argv[2];

async function main() {
  const rows = await prisma.callRecording.findMany({
    where: { twilioCallSid: callSid },
    orderBy: { createdAt: 'desc' },
  });

  console.log(JSON.stringify(rows, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
'@

$TempScript = "apps\api\.tmp-recordings-query.cjs"
Set-Content -LiteralPath $TempScript -Value $QueryScript -Encoding utf8
Push-Location apps\api
node .tmp-recordings-query.cjs $CallSid | Tee-Object -FilePath "..\..\recordings-$CallSid.json"
Pop-Location
Remove-Item -LiteralPath $TempScript
```

## Download Recordings From Stored Database SIDs

```powershell
$CallSid = "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$Rows = Get-Content ".\recordings-$CallSid.json" -Raw | ConvertFrom-Json
$OutDir = ".\recordings\$CallSid"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($Row in $Rows) {
  $RecordingSid = $Row.twilioRecordingSid
  Invoke-WebRequest `
    -Headers $Headers `
    -Uri "$TwilioBase/Recordings/$RecordingSid.mp3" `
    -OutFile "$OutDir\$RecordingSid.mp3"
}
```
