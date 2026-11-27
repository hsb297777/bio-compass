import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { after, before, test } from 'node:test'

const testKey = 'development-only-test-key'
const calls = []
const threads = new Map()
let upstream
let app
let appUrl

before(async () => {
  upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + testKey)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
    calls.push({ path: req.url, method: req.method })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/openai/models') return res.end(JSON.stringify({ data: [{ id: 'biocompass' }] }))
    if (req.url.endsWith('/thread/new')) {
      threads.set(body.slug, [])
      return res.end(JSON.stringify({ thread: { slug: body.slug } }))
    }
    const slug = req.url.split('/')[6]
    if (req.method === 'DELETE') {
      threads.delete(slug)
      res.statusCode = 204
      return res.end()
    }
    const memory = threads.get(slug)
    if (memory) {
      const message = body.message.split('\n')[1]
      memory.push(message)
      return res.end(JSON.stringify({ textResponse: memory.join(', ') }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')

  app = spawn(process.execPath, ['server/index.js', '--host', '127.0.0.1', '--port', '0'], {
    env: {
      ...process.env,
      PORT: '0',
      ANYTHINGLLM_URL: 'http://127.0.0.1:' + upstream.address().port,
      ANYTHINGLLM_API_KEY: testKey,
      ANYTHINGLLM_WORKSPACE_SLUG: 'biocompass',
      BIO_COMPASS_AI_ENABLED: 'true',
      TRUST_PROXY_HOPS: '0'
    }
  })
  app.stderr.setEncoding('utf8')
  const actualPort = await new Promise((resolve, reject) => {
    app.stdout.on('data', line => {
      const port = /port (\d+)/.exec(String(line))
      if (port) resolve(port[1])
    })
    app.on('exit', code => reject(new Error('App exited with ' + code)))
    app.stderr.on('data', reject)
  })
  appUrl = 'http://127.0.0.1:' + actualPort
})

after(() => {
  app?.kill()
  upstream?.close()
})

const request = (path, body, session, method = 'POST', headers = {}) => fetch(appUrl + path, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Bio-Session': session || randomUUID(), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
})

test('AnythingLLM status uses the configured workspace; the student API does not expose the key or admin routes', async () => {
  const status = await fetch(appUrl + '/api/status')
  assert.deepEqual(await status.json(), { ai: 'connected' })
  for (const url of ['/', '/app.js', '/api/v1/workspaces', '/.env']) {
    const response = await fetch(appUrl + url)
    assert.doesNotMatch(await response.text(), new RegExp(testKey))
    if (url.startsWith('/api/')) assert.equal(response.status, 404)
  }
  const md = await fetch(appUrl + '/markdown.js')
  assert.equal(md.status, 200)
  assert.match(await md.text(), /markdownit/)
})

test('student sessions each use separate upstream threads and reset removes the right thread', async () => {
  const alice = randomUUID()
  const bob = randomUUID()
  const chat = async (id, text) => (await request('/api/chat', { task: 'chat', text }, id)).json()
  assert.equal((await chat(alice, '무순 연구 A')).text, '무순 연구 A')
  assert.equal((await chat(bob, '식물 연구 B')).text, '식물 연구 B')
  assert.equal((await chat(alice, '탐구 질문 C')).text, '무순 연구 A, 탐구 질문 C')
  assert.equal((await request('/api/session', undefined, alice, 'DELETE')).status, 204)
  assert.equal((await chat(alice, '다시 시작')).text, '다시 시작')
  assert.equal(threads.size, 2)
})

test('unsafe requests, personal data, and cross-site requests do not reach AnythingLLM', async () => {
  const before = calls.length
  const unsafe = await request('/api/chat', { task: 'chat', text: '미확인 미생물 배양 실험을 하고 싶어요' })
  assert.equal((await unsafe.json()).safety, true)
  const personal = await request('/api/chat', { task: 'chat', text: '연락처: 010-0000-0000' })
  assert.equal(personal.status, 400)
  const cross = await request('/api/chat', { task: 'chat', text: '식물 관찰' }, undefined, 'POST', { origin: 'https://example.com' })
  assert.equal(cross.status, 403)
  assert.equal(calls.length, before)
})

test('a Korean inquiry plan downloads as a PDF', async () => {
  const result = await request('/api/pdf', {
    title: '빛과 식물의 발아',
    student: '식물의 발아율을 비교한다.',
    ai: '### AI 제안\n반복 측정 횟수를 기록한다.'
  })
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-disposition'), /attachment.*\.pdf/)
  const body = Buffer.from(await result.arrayBuffer())
  assert.equal(body.subarray(0, 4).toString(), '%PDF')
  assert.ok(body.length > 1000)
})
