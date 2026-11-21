const { startMasterRelay, stopRelay, getRelayInfo, activeRelays } = require('./native-host/stream-relay');
const http = require('http');

function createM3U8Server(manifestContent, segmentContent = 'segment-data') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/video.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end(manifestContent);
      } else if (url.pathname === '/audio.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n');
      } else if (url.pathname.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.end(segmentContent);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: 'http://127.0.0.1:' + port });
    });
  });
}

async function test() {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts'
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio1.ts\n#EXTINF:10,\naudio2.ts'
  );

  const videoUrl = videoBase + '/video.m3u8';
  const audioUrl = audioBase + '/audio.m3u8';

  const result = await startMasterRelay(videoUrl, {}, audioUrl, {});
  console.log('result:', result);
  
  // Check active relays
  console.log('activeRelays keys before:', [...activeRelays.keys()]);
  
  // Fetch video sub-relay manifest
  try {
    const videoResponse = await fetch(result.videoRelayUrl);
    const videoManifest = await videoResponse.text();
    console.log('video manifest:', videoManifest);
    assert.ok(videoManifest.includes('#EXTM3U'));
    // Segments should be rewritten to point through the relay
    assert.ok(videoManifest.includes('/video/'));
    assert.ok(videoManifest.includes('seg1.ts'));
  } catch (e) {
    console.log('video fetch error:', e.message, e.stack);
  }
  
  // Fetch audio sub-relay manifest
  try {
    const audioResponse = await fetch(result.audioRelayUrl);
    const audioManifest = await audioResponse.text();
    console.log('audio manifest:', audioManifest);
    assert.ok(audioManifest.includes('#EXTM3U'));
    assert.ok(audioManifest.includes('/audio/'));
    assert.ok(audioManifest.includes('audio1.ts'));
  } catch (e) {
    console.log('audio fetch error:', e.message, e.stack);
  }
  
  // Check active relays after fetch
  console.log('activeRelays keys after fetch:', [...activeRelays.keys()]);
  
  // Stop master relay
  stopRelay(result.token);
  console.log('after stop, activeRelays keys:', [...activeRelays.keys()]);
  
  // Verify all relays are cleaned up
  console.log('master relay exists:', activeRelays.has(result.token));
  console.log('video relay exists:', activeRelays.has(result.videoToken));
  console.log('audio relay exists:', activeRelays.has(result.audioToken));
  
  videoServer.close();
  audioServer.close();
}

test().catch(e => console.error('test error:', e.message, e.stack));

function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}