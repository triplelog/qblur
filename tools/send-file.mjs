/**
 * Sends a file's bytes, honouring a Range request — without it a browser
 * cannot seek in a video (it quietly stays on the first frame).
 */
export function sendFile(req, res, body, headers) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!range) {
        res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
        res.end(body);
        return;
    }
    const start = range[1] === '' ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start > end || start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
    }
    res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
    res.end(body.subarray(start, end + 1));
}
