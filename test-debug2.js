const { startMasterRelay, stopRelay, getRelayInfo } = require('./native-host/stream-relay');
const http = require('http');

function createM3U8Server(manifestContent, segmentContent = 'segment-data') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      console.log('Test server request:', req.url, 'pathname:', url.pathname);
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
  
  // Check the video relay manifest
  try {
    const response = await fetch(result.videoRelayUrl);
    const text = await response.text();
    console.log('video manifest:');
    console.log(text);
    
    // Extract first segment URL and fetch it
    const segmentLine = text.split('\n').find(l => l.includes('seg1.ts'));
    if (segmentLine) {
      const segmentUrl = segmentLine.trim();
      console.log('Fetching segment:', segmentUrl);
      const segResponse = await fetch(segmentUrl);
      const segData = await segResponse.text();
      console.log('Segment data:', segData);
    }
  } catch (e) {
    console.log('video fetch error:', e.message, e.stack);
  }
  
  stopRelay(result.token);
  console.log('after stop, master relay info:', getRelayInfo(result.token));
  
  videoServer.close();
  audioServer.close();
}

test().catch(e => console.error('test error:', e.message, e.stack));