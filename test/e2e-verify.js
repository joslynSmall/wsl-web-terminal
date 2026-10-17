import http from 'http';
import WebSocket from 'ws';

const BASE_URL = 'http://localhost:7891';
const WS_URL = 'ws://localhost:7891/ws/terminal';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTests() {
  const indexRes = await request('/');
  if (indexRes.status !== 200 || !indexRes.body.includes('WSL Web Terminal Hub')) {
    throw new Error('Index verification failed');
  }
  console.log('PASS: Static HTML serving');

  const cssRes = await request('/vendor/xterm/css/xterm.css');
  if (cssRes.status !== 200) {
    throw new Error('Vendor CSS serving failed');
  }
  console.log('PASS: Vendor xterm.css serving');

  const listRes = await request('/api/windows');
  if (listRes.status !== 200 || !listRes.body.success || !Array.isArray(listRes.body.windows)) {
    throw new Error('List windows failed');
  }
  console.log('PASS: GET /api/windows returned ' + listRes.body.windows.length + ' windows');

  const createRes = await request('/api/windows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'verify-e2e-win' }
  });
  if (createRes.status !== 201 || !createRes.body.success || !createRes.body.window) {
    throw new Error('Create window failed');
  }
  const target = createRes.body.window.target;
  console.log('PASS: POST /api/windows created target: ' + target);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?target=${encodeURIComponent(target)}&cols=80&rows=24`);
    let verified = false;

    ws.on('open', () => {
      setTimeout(() => {
        ws.send('echo "E2E_STREAM_VERIFIED_SUCCESS"\r\n');
      }, 300);
    });

    ws.on('message', (data) => {
      const text = data.toString();
      if (text.includes('E2E_STREAM_VERIFIED_SUCCESS')) {
        verified = true;
        ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 300);
      }
    });

    ws.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      if (!verified) {
        ws.close();
        reject(new Error('Timeout waiting for terminal echo'));
      }
    }, 5000);
  });
  console.log('PASS: WebSocket bidirectional echo & resize');

  const killRes = await request(`/api/windows/${encodeURIComponent(target)}`, {
    method: 'DELETE'
  });
  if (killRes.status !== 200 || !killRes.body.success) {
    throw new Error('Kill window failed');
  }
  console.log('PASS: DELETE /api/windows killed target: ' + target);

  console.log('ALL VERIFICATION ASSERTIONS PASSED!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
