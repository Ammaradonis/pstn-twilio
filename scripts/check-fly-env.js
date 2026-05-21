const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '../env.txt');
  const envTxt = fs.readFileSync(envPath, 'utf8');
  const flyTokenMatch = envTxt.match(/FLY_API_TOKEN=(.+)/);
  if (!flyTokenMatch) {
    console.error('FLY_API_TOKEN not found in env.txt');
    process.exit(1);
  }
  const flyToken = flyTokenMatch[1].trim();
  process.env.FLY_API_TOKEN = flyToken;

  const cmd = `node -e "const print = (k) => console.log(k + \\" length: \\" + (process.env[k] || \\"\\").length + \\", prefix: \\" + (process.env[k] || \\"\\").slice(0, 4)); print(\\"TWILIO_ACCOUNT_SID\\"); print(\\"TWILIO_AUTH_TOKEN\\"); print(\\"TWILIO_API_KEY_SID\\"); print(\\"TWILIO_API_KEY_SECRET\\");"`;
  const output = execSync(`fly ssh console -c deploy/fly.toml -C "${cmd.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(output);
} catch (err) {
  console.error('Error executing fly ssh console:', err.message);
  if (err.stdout) console.log('stdout:', err.stdout);
  if (err.stderr) console.log('stderr:', err.stderr);
}
