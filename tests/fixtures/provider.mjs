// Synthetic OpenAI-compatible endpoint for opt-in live Gateway validation only.
import http from 'node:http';
http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'test', object: 'model', owned_by: 'validation' }],
        }),
      );
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    const text = 'Gateway integration verified with a synthetic provider response.';
    if (data.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const delta of [{ role: 'assistant', content: '' }, { content: text }])
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'validation',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'test',
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            '\n\n',
        );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'validation',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'validation',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  })
  .listen(19999, '127.0.0.1', () =>
    console.log('Synthetic provider ready on loopback port 19999.'),
  );
