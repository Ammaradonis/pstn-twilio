const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Read fly token
const envPath = path.join(__dirname, '..', 'env.txt');
const envContent = fs.readFileSync(envPath, 'utf8');
const flyTokenMatch = envContent.match(/FLY_API_TOKEN=(.*)/);
if (!flyTokenMatch) {
  console.error('FLY_API_TOKEN not found in env.txt');
  process.exit(1);
}
const flyToken = flyTokenMatch[1].trim();

// Command to execute inside VM
const nodeCode = `
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
console.log('Validating Live API Credentials on Twilio...');
client.availablePhoneNumbers.list()
  .then(res => {
    console.log('SUCCESS: Active Twilio API Key is fully valid! Available countries count:', res.length);
  })
  .catch(err => {
    console.error('ERROR validating Twilio API Key:', err.message);
  });
`;

const flyArgs = [
  'ssh',
  'console',
  '-c',
  'deploy/fly.toml',
  '-C',
  `node -e "${nodeCode.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
];

console.log('Executing fly ssh console...');
const result = spawnSync('fly', flyArgs, {
  env: { ...process.env, FLY_API_TOKEN: flyToken },
  encoding: 'utf8',
});

console.log('stdout:', result.stdout);
console.log('stderr:', result.stderr);
process.exit(result.status);
