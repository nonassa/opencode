type SubscriptionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export function chatGptSubscriptionFetch(
  options: { tokenUrl: string; leaseTokenEnvironmentVariable: string },
  send: SubscriptionFetch = fetch,
  environment: Record<string, string | undefined> = process.env,
): SubscriptionFetch {
  const tokenUrl = new URL(options.tokenUrl)
  if (tokenUrl.protocol !== 'http:' || tokenUrl.hostname !== '127.0.0.1' || tokenUrl.username || tokenUrl.password
    || tokenUrl.pathname !== '/mcp/authoring/chatgpt-token') throw new Error('A protected task subscription endpoint is required.')
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.url !== 'https://api.openai.com/v1/responses' || request.method !== 'POST') {
      throw new Error('ChatGPT subscription supports only official Responses requests.')
    }
    const lease = environment[options.leaseTokenEnvironmentVariable]
    if (!lease) throw new Error('Reconnect the task ChatGPT subscription account to continue.')
    const authorization = await fetch(tokenUrl, { method: 'POST', headers: { Authorization: `Bearer ${lease}` },
      body: '{}', signal: request.signal })
    if (!authorization.ok) throw new Error('Reconnect the task ChatGPT subscription account to continue.')
    const token = await authorization.json() as { accessToken?: unknown }
    if (typeof token.accessToken !== 'string' || !token.accessToken) throw new Error('Reconnect the task ChatGPT subscription account to continue.')
    const payload = await request.json() as Record<string, unknown>
    const allowed = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'text',
      'include', 'prompt_cache_key']
    const body = Object.fromEntries(allowed.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]))
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = [{ type: 'namespace', name: 'stratcraft', tools: body.tools }]
    }
    if (Array.isArray(body.input)) {
      body.input = body.input.map(item => item && typeof item === 'object' && item.type === 'function_call'
        ? { ...item, namespace: 'stratcraft' }
          : item && typeof item === 'object' && item.role === 'system' ? { ...item, role: 'developer' } : item)
    }
    if (body.tool_choice && typeof body.tool_choice === 'object' && 'type' in body.tool_choice && body.tool_choice.type === 'function') {
      body.tool_choice = { ...body.tool_choice, namespace: 'stratcraft' }
    }
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${token.accessToken}`)
    headers.set('content-type', 'application/json')
    const response = await send(request.url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true, store: false }),
      signal: request.signal })
    if (!response.ok) {
      await response.body?.cancel()
      const message = response.status === 429 ? 'ChatGPT subscription quota or rate limit reached.'
        : response.status === 401 || response.status === 403 ? 'Reconnect the task ChatGPT subscription account to continue.'
        : 'The selected ChatGPT subscription model request failed.'
      return Response.json({ error: { message, type: 'subscription_error' } }, { status: response.status })
    }
    return response
  }
}
