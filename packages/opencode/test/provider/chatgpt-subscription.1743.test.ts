import { test, expect, afterEach } from 'bun:test'
import { chatGptSubscriptionFetch } from '../../src/provider/chatgpt-subscription'
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => servers.splice(0).forEach(server => server.stop(true)))
test('renews each Responses request, omits unsupported fields and never falls back after revoked authorization', async () => {
  let renewal = 0
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer owned-task-lease')
    renewal++
    return renewal > 2 ? new Response('', { status: 403 }) : Response.json({ accessToken: `subscription-${renewal}` })
  } })
  servers.push(server)
  const upstream: Request[] = []
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_1743_TASK_LEASE' }, async (input, init) => {
    const request = new Request(input, init)
    upstream.push(request)
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, { TEST_1743_TASK_LEASE: 'owned-task-lease' })
  const payload = { model: 'eligible', input: [{ role: 'system', content: 'task instructions' }, { role: 'user', content: 'code' }], store: true, stream: false,
    max_output_tokens: 999, temperature: 0.7, service_tier: 'auto', safety_identifier: 'unsupported', tools: [{ type: 'function', name: 'read', parameters: {} }] }
  await send('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(payload) })
  await send('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(payload) })
  expect(upstream.map(request => request.headers.get('authorization'))).toEqual(['Bearer subscription-1', 'Bearer subscription-2'])
  expect(await upstream[0].json()).toEqual({ model: 'eligible', input: [{ role: 'developer', content: 'task instructions' }, { role: 'user', content: 'code' }], store: false, stream: true, tools: [{ type: 'namespace', name: 'stratcraft', description: 'StratCraft operation tools', tools: payload.tools }] })
  await expect(send('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(payload) })).rejects.toThrow('Reconnect')
  expect(upstream.length).toBe(2)
  await expect(send('https://evil.example/responses', {})).rejects.toThrow('Responses')
})

test('actual OpenAI SDK decodes namespaced subscription tool calls and keeps the native tool name', async () => {
  const { createOpenAI } = await import('@ai-sdk/openai')
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'subscription-access' }) })
  servers.push(server)
  let body: Record<string, unknown> | undefined
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async (_input, init) => {
    body = JSON.parse(String(init?.body))
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', namespace: 'stratcraft', arguments: '' }
    const events = [
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'eligible', service_tier: null } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":"strategy.py"}' },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', arguments: '{"path":"strategy.py"}' } },
      { type: 'response.completed', response: { incomplete_details: null, service_tier: null,
        usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: null, output_tokens_details: null } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  }, { TEST_TASK_LEASE: 'task-lease' })
  const model = createOpenAI({ apiKey: 'managed-subscription', fetch: Object.assign(send, { preconnect: fetch.preconnect }) }).responses('eligible')
  const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Inspect source' }] }],
    tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] })
  const reader = result.stream.getReader()
  const chunks: import('@ai-sdk/provider').LanguageModelV3StreamPart[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  expect(body?.tools).toMatchObject([{ type: 'namespace', name: 'stratcraft', description: 'StratCraft operation tools', tools: [{ name: 'read' }] }])
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'read', toolCallId: 'call_1', input: '{"path":"strategy.py"}' }))
  expect(chunks.some(chunk => chunk.type === 'error')).toBe(false)
})

test('actual SDK preserves automatic and explicit tool selection and stateless tool continuation', async () => {
  const { createOpenAI } = await import('@ai-sdk/openai')
  let renewals = 0
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
    renewals++
    return Response.json({ accessToken: 'fixture-access' })
  } })
  servers.push(server)
  const requests: Record<string, unknown>[] = []
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, { TEST_TASK_LEASE: 'fixture-lease' })
  const model = createOpenAI({ apiKey: 'managed-subscription', fetch: Object.assign(send, { preconnect: fetch.preconnect }) }).responses('gpt-6.1-sol')
  const prompt = [{ role: 'system' as const, content: 'Reviewed workspace instructions' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect source' }] }]
  const tools = [{ type: 'function' as const, name: 'read', description: 'Read source', strict: false,
    inputSchema: { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] } }]
  for (const toolChoice of [{ type: 'auto' as const }, { type: 'tool' as const, toolName: 'read' }]) {
    const result = await model.doStream({ prompt, tools, toolChoice })
    await result.stream.cancel()
  }
  const continuation = await model.doStream({ prompt: [...prompt,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'read', input: { path: 'strategy.py' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read', output: { type: 'text', value: 'Reviewed source' } }] }], tools })
  await continuation.stream.cancel()
  const noTools = await model.doStream({ prompt })
  await noTools.stream.cancel()
  expect(renewals).toBe(4)
  expect(requests[0]).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, tool_choice: 'auto',
    tools: [{ type: 'namespace', name: 'stratcraft', description: 'StratCraft operation tools',
      tools: [{ type: 'function', name: 'read', description: 'Read source', strict: false, parameters: tools[0].inputSchema }] }],
    input: [{ role: 'developer', content: 'Reviewed workspace instructions' }, { role: 'user' }] })
  expect(requests[1].tool_choice).toEqual({ type: 'function', name: 'read' })
  expect(requests[2].input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'read', namespace: 'stratcraft', arguments: '{"path":"strategy.py"}' }),
    expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: 'Reviewed source' }),
  ]))
  expect(requests[3].tools).toBeUndefined()
})

test.each([
  { status: 400, error: { code: 'missing_required_parameter', type: 'invalid_request_error', param: 'tools[0].description' },
    expected: { code: 'missing_required_parameter', type: 'invalid_request_error', param: 'tools[0].description' } },
  { status: 401, error: { code: 'invalid_api_key', type: 'authentication_error' },
    expected: { code: 'invalid_api_key', type: 'authentication_error' } },
  { status: 403, error: { code: 'subscription_sharing_user_not_eligible' },
    expected: { code: 'subscription_sharing_user_not_eligible', type: 'subscription_error' } },
  { status: 429, error: { code: 'subscription_sharing_usage_limit_exceeded', type: 'rate_limit_error' },
    expected: { code: 'subscription_sharing_usage_limit_exceeded', type: 'rate_limit_error' } },
  { status: 503, error: { code: 'subscription_sharing_usage_unavailable', type: 'server_error' },
    expected: { code: 'subscription_sharing_usage_unavailable', type: 'server_error' } },
  { status: 400, error: { code: 'fixture-access', type: 'fixture-lease', param: 'input.fixture-access' },
    expected: { type: 'subscription_error' } },
])('retains safe structured subscription failure facts for HTTP $status', async ({ status, error, expected }) => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'fixture-access' }) })
  servers.push(server)
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => Response.json({ error: { ...error, message: 'raw fixture-access fixture-lease' } },
      { status, headers: { 'x-request-id': 'req_0123456789abcdef', 'set-cookie': 'fixture-access' } }),
    { TEST_TASK_LEASE: 'fixture-lease' })
  const response = await send('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"eligible","input":[]}' })
  expect(response.status).toBe(status)
  expect(response.headers.get('x-request-id')).toBe('req_0123456789abcdef')
  expect(response.headers.get('set-cookie')).toBeNull()
  const body = await response.json()
  expect(body.error).toMatchObject(expected)
  expect(body.error.message).toContain(`HTTP ${status}`)
  if ('param' in expected) expect(body.error.message).toContain(expected.param)
  if ('code' in expected) expect(body.error.message).toContain(expected.code)
  expect(JSON.stringify(body)).not.toMatch(/fixture-access|fixture-lease|raw/)
})

test.each(['plain secret text', '{invalid JSON', JSON.stringify({ detail: 'raw provider prose' }),
  JSON.stringify({ error: null }), JSON.stringify({ error: [] }), JSON.stringify(null),
  JSON.stringify({ error: 'raw provider prose' }), 'x'.repeat(20000)])(
  'unknown and non-JSON failure bodies remain redacted', async (body) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'fixture-access' }) })
    servers.push(server)
    const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
      leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => new Response(body, { status: 400,
        headers: { 'x-request-id': 'fixture-access' } }), { TEST_TASK_LEASE: 'fixture-lease' })
    const response = await send('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"eligible","input":[]}' })
    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toBeNull()
    expect(await response.json()).toEqual({ error: { type: 'subscription_error',
      message: 'The selected ChatGPT subscription model request failed. (HTTP 400)' } })
  })

test('actual SDK error retains safe diagnostics for native error persistence', async () => {
  const { createOpenAI } = await import('@ai-sdk/openai')
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'fixture-access' }) })
  servers.push(server)
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => Response.json({ error: {
      message: 'raw fixture-access', type: 'invalid_request_error', code: 'missing_required_parameter', param: 'tools[0].description' } },
      { status: 400, headers: { 'x-request-id': 'req_0123456789abcdef' } }), { TEST_TASK_LEASE: 'fixture-lease' })
  const model = createOpenAI({ apiKey: 'managed-subscription', fetch: Object.assign(send, { preconnect: fetch.preconnect }) }).responses('gpt-6.1-sol')
  const error = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Inspect fixture' }] }] })
    .then(() => undefined, (error: unknown) => error)
  const { APICallError } = await import('@ai-sdk/provider')
  expect(APICallError.isInstance(error)).toBe(true)
  if (!APICallError.isInstance(error)) throw new Error('Expected SDK API error')
  expect(error.statusCode).toBe(400)
  expect(error.isRetryable).toBe(false)
  expect(error.message).toContain('parameter: tools[0].description')
  expect(error.responseHeaders?.['x-request-id']).toBe('req_0123456789abcdef')
  expect(JSON.parse(error.responseBody!)).toMatchObject({ error: { code: 'missing_required_parameter', param: 'tools[0].description' } })
  expect(error.responseBody).not.toContain('fixture-access')
})

test('malformed diagnostics and credentials shaped like public identifiers are omitted', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'invalid_api_key' }) })
  servers.push(server)
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => Response.json({ error: {
      type: 'invalid_api_key', code: 'invalid_api_key', param: 'tools[0].description\nfixture-secret' } },
      { status: 400, headers: { 'x-request-id': 'req_invalid_api_key' } }), { TEST_TASK_LEASE: 'fixture-lease' })
  const response = await send('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"eligible","input":[]}' })
  expect(response.headers.get('x-request-id')).toBeNull()
  expect(await response.json()).toEqual({ error: { type: 'subscription_error',
    message: 'The selected ChatGPT subscription model request failed. (HTTP 400)' } })
})

test.each([null, new ReadableStream({ start(controller) { controller.error(new Error('raw provider failure')) } })])(
  'missing or unreadable error body preserves the original HTTP failure', async (body) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'fixture-access' }) })
    servers.push(server)
    const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
      leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => new Response(body, { status: 400 }),
      { TEST_TASK_LEASE: 'fixture-lease' })
    const response = await send('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"eligible","input":[]}' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { type: 'subscription_error',
      message: 'The selected ChatGPT subscription model request failed. (HTTP 400)' } })
  })

test('quota failure stays on the subscription route and redacts raw upstream error content', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ accessToken: 'secret-1743' }) })
  servers.push(server)
  const send = chatGptSubscriptionFetch({ tokenUrl: `http://127.0.0.1:${server.port}/mcp/authoring/chatgpt-token`,
    leaseTokenEnvironmentVariable: 'TEST_TASK_LEASE' }, async () => Response.json({ error: { message: 'raw credential secret-1743' } }, { status: 429 }),
    { TEST_TASK_LEASE: 'task-lease' })
  const response = await send('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"eligible","input":[],"tools":[]}' })
  expect(response.status).toBe(429)
  const body = await response.text()
  expect(body).toContain('quota or rate limit')
  expect(body).not.toContain('secret-1743')
})
