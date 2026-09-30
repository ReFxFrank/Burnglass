// Mock of the ECB daily reference rates (eurofxref-daily.xml) for the
// currency suite. Usage: node mock-ecb.js <port>
//   GET /eurofxref-daily.xml  the rates (mode ok), HTTP 500 (mode 500) or a
//                             non-XML body (mode junk)
//   GET /mode?m=ok|500|junk   switch the mode
//   GET /count                how many rate requests were served
'use strict';
const http = require('http');
const port = Number(process.argv[2]) || 4931;
let mode = 'ok';
let count = 0;
// Rates per 1 EUR, shaped like the real file (single-quoted attributes).
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='2026-09-29'>
			<Cube currency='USD' rate='1.25'/>
			<Cube currency='JPY' rate='187.5'/>
			<Cube currency='GBP' rate='0.875'/>
			<Cube currency='CHF' rate='1.0'/>
			<Cube currency='CAD' rate='1.75'/>
		</Cube>
	</Cube>
</gesmes:Envelope>
`;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mode') {
    mode = u.searchParams.get('m') || 'ok';
    res.end('mode ' + mode);
    return;
  }
  if (u.pathname === '/count') { res.end(String(count)); return; }
  if (u.pathname === '/eurofxref-daily.xml') {
    count++;
    if (mode === '500') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(mode === 'junk' ? '<html>maintenance</html>' : XML);
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log('mock ecb on ' + port));
