type SubscriptionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const SUBSCRIPTION_ERROR_BODY_BYTES = 16 * 1024
const SUBSCRIPTION_PARAMETER_LENGTH = 256
const SUBSCRIPTION_ERROR_CODES = new Set(['missing_required_parameter', 'unknown_parameter', 'invalid_value', 'invalid_type',
  'invalid_request_error', 'invalid_api_key', 'model_not_found', 'context_length_exceeded',
  'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'])
const SUBSCRIPTION_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'rate_limit_error', 'server_error'])
const SUBSCRIPTION_PARAMETER = /^(?:model|input|instructions|tools|tool_choice|parallel_tool_calls|reasoning|text|include|prompt_cache_key|stream|store)(?:\[\d{1,6}\]|\.(?:type|name|description|tools|namespace|role|content|parameters|strict|effort|summary|format|verbosity))*$/
const SUBSCRIPTION_REQUEST_ID = /^req_[A-Za-z0-9_-]{1,64}$/
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
      body.tools = [{ type: 'namespace', name: 'stratcraft', description: 'StratCraft operation tools', tools: body.tools }]
    }
    if (Array.isArray(body.input)) {
      body.input = body.input.map(item => item && typeof item === 'object' && item.type === 'function_call'
        ? { ...item, namespace: 'stratcraft' }
          : item && typeof item === 'object' && item.role === 'system' ? { ...item, role: 'developer' } : item)
    }
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${token.accessToken}`)
    headers.set('content-type', 'application/json')
    const response = await send(request.url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true, store: false }),
      signal: request.signal })
    if (!response.ok) {
      const error = await readSubscriptionError(response)
      const safe = (value: unknown): value is string => typeof value === 'string'
        && ![token.accessToken as string, lease].some(secret => value.includes(secret))
      const code = safe(error.code) && SUBSCRIPTION_ERROR_CODES.has(error.code) ? error.code : undefined
      const param = safe(error.param) && error.param.length <= SUBSCRIPTION_PARAMETER_LENGTH
        && SUBSCRIPTION_PARAMETER.test(error.param) ? error.param : undefined
      const type = safe(error.type) && SUBSCRIPTION_ERROR_TYPES.has(error.type) ? error.type : 'subscription_error'
      const requestId = response.headers.get('x-request-id')
      const correlationId = safe(requestId) && SUBSCRIPTION_REQUEST_ID.test(requestId) ? requestId : undefined
      const message = response.status === 429 ? 'ChatGPT subscription quota or rate limit reached.'
        : response.status === 401 || response.status === 403 ? 'Reconnect the task ChatGPT subscription account to continue.'
        : 'The selected ChatGPT subscription model request failed.'
      const details = [`HTTP ${response.status}`, ...(code ? [`code: ${code}`] : []),
        ...(param ? [`parameter: ${param}`] : []), ...(correlationId ? [`request: ${correlationId}`] : [])]
      return Response.json({ error: { message: `${message} (${details.join('; ')})`, type,
        ...(code ? { code } : {}), ...(param ? { param } : {}) } }, { status: response.status,
        ...(correlationId ? { headers: { 'x-request-id': correlationId } } : {}) })
    }
    return response
  }
}

/** Consume only bounded structured facts; raw provider prose never leaves this adapter. */
async function readSubscriptionError(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > SUBSCRIPTION_ERROR_BODY_BYTES) {
        await reader.cancel()
        return {}
      }
      chunks.push(next.value)
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return result && typeof result.error === 'object' && result.error !== null && !Array.isArray(result.error)
      ? result.error : {}
  } catch {
    return {}
  } finally {
    reader.releaseLock()
  }
}
