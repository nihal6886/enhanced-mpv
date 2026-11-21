const { rewriteManifestUrls } = require('./native-host/stream-relay');

const manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts
#EXTINF:10,
seg2.ts`;

// Test with the actual URL format from the test
const base = 'http://127.0.0.1:12345/token/video/';
const manifestBaseUrl = 'http://127.0.0.1:54321/video.m3u8';

const result = rewriteManifestUrls(manifest, base, manifestBaseUrl);
console.log('Result:');
console.log(result);