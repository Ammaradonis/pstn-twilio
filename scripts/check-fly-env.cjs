const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '../env.txt');
  const envTxt = fs.readFileSync(envPath, 'utf8');
  const flyTokenMatch = envTxt.match(/FLY_API_TOKEN=(.+)/);
  if (!flyTokenMatch) {
    console.error("FLY_API_TOKEN not found in env.txt");
    process.exit(1);
  }
  const flyToken = flyTokenMatch[1].trim();
  process.env.FLY_API_TOKEN = flyToken;

  const remoteCmd = `node -e '
const twilio = require(\"twilio\");
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
client.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).fetch()
  .then(acc => console.log(\"Live Auth Token check SUCCESS! Status:\", acc.status))
  .catch(err => console.log(\"Live Auth Token check FAILED:\", err.message));
'`;

  const res = spawnSync('fly', [
    'ssh', 'console',
    '-c', 'deploy/fly.toml',
    '-C', remoteCmd
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  console.log("stdout:", res.stdout);
  console.log("stderr:", res.stderr);
  console.log("status:", res.status);
} catch (err) {
  console.error("Error executing fly: ", err.message);
}
