'use strict';
/**
 * Resolve the Python provider script for dev and packaged runs (F7.1).
 *
 * A packaged app ships provider/** inside app.asar, which Python cannot read.
 * `build.asarUnpack` in package.json copies those files to
 * `<resources>/app.asar.unpacked/provider/`; when that copy is missing (e.g. a
 * build made without the asarUnpack entry) we keep the historical in-asar path
 * so the failure is reported by Python instead of silently pointing nowhere.
 *
 * @module platform/electron/provider-path
 */

const path = require('node:path');

function providerScript(name, opts) {
  const o = opts || {};
  const root = o.rootDir || __dirname;
  if (o.packaged) {
    const unpacked = path.join(o.resourcesPath || '', 'app.asar.unpacked', 'provider', name);
    const exists = o.fileExists || (() => true);
    if (exists(unpacked)) return unpacked;
  }
  return path.join(root, 'provider', name);
}

module.exports = { providerScript };
