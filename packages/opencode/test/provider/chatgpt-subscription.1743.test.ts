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
  expect(await upstream[0].json()).toEqual({ model: 'eligible', input: [{ role: 'developer', content: 'task instructions' }, { role: 'user', content: 'code' }], store: false, stream: true, tools: [{ type: 'namespace', name: 'stratcraft', tools: payload.tools }] })
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
  expect(body?.tools).toMatchObject([{ type: 'namespace', name: 'stratcraft', tools: [{ name: 'read' }] }])
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'read', toolCallId: 'call_1', input: '{"path":"strategy.py"}' }))
  expect(chunks.some(chunk => chunk.type === 'error')).toBe(false)
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
