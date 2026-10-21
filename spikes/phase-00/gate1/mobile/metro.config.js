const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'mjs'])];
module.exports = config;
