const path = require('node:path');

// Externalize all bare-specifier imports (third-party packages and Node built-ins)
// so they're resolved at runtime from /app/node_modules, not bundled. This is required
// because:
//   1. Native modules (argon2, bcrypt, etc.) can't be bundled
//   2. pnpm workspace symlink layout confuses webpack-node-externals' modulesDir scan
// Workspace packages (@pstn-twilio/*) are NOT externalized so they're inlined.
module.exports = (options) => ({
  ...options,
  externals: [
    ({ request }, callback) => {
      if (!request) return callback();
      // Inline workspace packages and relative/absolute paths
      if (
        request.startsWith('.') ||
        path.isAbsolute(request) ||
        request.startsWith('@pstn-twilio/')
      ) {
        return callback();
      }
      // Externalize everything else (npm packages + node: built-ins)
      return callback(null, 'commonjs ' + request);
    },
  ],
});
