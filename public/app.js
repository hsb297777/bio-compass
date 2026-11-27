const byId = id => document.getElementById(id)
const md = window.markdownit?.({ html: false, linkify: true })
const profileForm = byId('profile-form')
const messages = byId('messages')
const searchResults = byId('search-results')
const paperForm = byId('search-form')
const paperQuery = byId('paper-query')
const suggestionsPanel = byId('paper-suggestions')
const suggestionsList = byId('suggestions-list')
const suggestionsStatus = byId('suggestions-status')
const suggestionCache = new Map()
let suggestionsTimer
let suggestionsRequest
const planResults = byId('plan-results')
const welcome = messages.firstElementChild.cloneNode(true)
const kindNames = { literature: '문헌 탐구형', experiment: '실험 탐구형', data: '데이터 분석형' }
let session = crypto.randomUUID()
let busy = false
let topic = ''
let planSuggestion = ''
let planSuggestionFor = ''
let stage = 0

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function markdown(text) {
  const region = element('div', 'md')
  if (!md) {
    region.textContent = text
    return region
  }
  region.innerHTML = md.render(text || '')
  for (const image of region.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.alt))
  for (const link of region.querySelectorAll('a')) {
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) link.removeAttribute('href')
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  for (const table of region.querySelectorAll('table')) {
    const scroll = element('div', 'table-scroll')
    scroll.tabIndex = 0
    scroll.setAttribute('role', 'region')
    scroll.setAttribute('aria-label', '답변 표')
    table.before(scroll)
    scroll.append(table)
  }
  return region
}

function progress(next, reset = false) {
  stage = reset ? next : Math.max(stage, next)
  for (const [i, step] of [...byId('steps').children].entries()) {
    if (i === stage) step.setAttribute('aria-current', 'step')
    else step.removeAttribute('aria-current')
    step.toggleAttribute('data-complete', i < stage)
  }
}

function panel(name) {
  if (name !== 'papers') clearSuggestions()
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.panel === name
    tab.setAttribute('aria-pressed', selected)
    byId(tab.dataset.panel).hidden = !selected
  }
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => panel(tab.dataset.panel))

function setBusy(value) {
  busy = value
  for (const node of document.querySelectorAll('#profile-submit, #send, #reset-chat, [data-plan-task], #search-button')) node.disabled = value
  byId('loading').hidden = !value || byId('chat').hidden
}

function showError(container, text) {
  const error = element('p', 'error', text)
  error.setAttribute('role', 'alert')
  container.append(error)
}

async function api(path, data, method = 'POST', signal) {
  let response
  try {
    response = await fetch('/api/' + path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', 'X-Bio-Session': session },
      body: data === undefined ? undefined : JSON.stringify(data)
    })
  } catch {
    throw new Error('연결이 끊겼어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.')
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || '요청에 실패했어요. 잠시 후 다시 시도해 주세요.')
  }
  return response
}

async function status() {
  const indicator = byId('connection')
  const labels = { connected: '연결 확인됨', unavailable: '연결 점검 필요', unconfigured: 'AI 설정 필요' }
  try {
    const response = await fetch('/api/status')
    const { ai } = await response.json()
    indicator.textContent = labels[ai] || labels.unavailable
    indicator.dataset.mode = ai
  } catch {
    indicator.textContent = labels.unavailable
  }
}
status()

function addStudent(text) {
  const container = element('div', 'message student')
  container.append(element('p', 'message-title', '나'), element('div', '', text))
  messages.append(container)
  messages.scrollTop = messages.scrollHeight
}

function addSources(container, sources) {
  if (!sources?.length) return
  const details = element('details', 'sources')
  details.append(element('summary', '', '참고 자료'))
  const list = element('ul')
  for (const name of sources) list.append(element('li', '', name))
  details.append(list)
  container.append(details)
}

function addTopics(container, topics) {
  const group = element('div', 'topic-list')
  for (const option of topics) {
    if (option.searchQueries?.length) {
      suggestionCache.set(option.title.slice(0, 200).trim(), option.searchQueries)
      suggestionCache.set(option.question.slice(0, 200).trim(), option.searchQueries)
    }
    const card = element('article', 'topic')
    card.append(element('p', 'topic-kind', kindNames[option.kind]),
      element('h3', '', option.title),
      element('p', '', '탐구 질문 · ' + option.question),
      element('p', '', '관련 개념 · ' + option.concepts),
      element('p', '', '추천 이유 · ' + option.reason),
      element('p', '', '난이도 · ' + option.difficulty))
    const select = element('button', 'button secondary', '이 주제 선택')
    select.type = 'button'
    select.addEventListener('click', () => {
      topic = option.title
      paperQuery.value = option.title.slice(0, 200)
      if (!byId('plan-title').value) byId('plan-title').value = option.title.slice(0, 180)
      panel('papers')
      paperQuery.focus()
      updateSuggestions(0)
    })
    card.append(select)
    group.append(card)
  }
  container.append(group)
}

function addReply(target, response) {
  const container = element('article', 'message')
  container.append(element('p', 'message-title', response.safety ? '안전 안내' : 'Compass AI'))
  if (response.text) container.append(markdown(response.text))
  if (response.topics) addTopics(container, response.topics)
  if (response.reviews) {
    const group = element('div', 'topic-list')
    for (const review of response.reviews) {
      const card = element('section', 'review')
      const score = review.score === undefined ? '' : review.score === null ? ' · 평가 보류' : ' · ' + review.score + '점'
      card.append(element('h3', '', review.criterion + score),
        element('p', '', '잘한 점 · ' + review.strength),
        element('p', '', '개선 방향 · ' + review.improvement))
      if (review.evidence) card.append(element('p', '', '평가 근거 · ' + review.evidence))
      group.append(card)
    }
    container.append(group)
  }
  addSources(container, response.sources)
  target.append(container)
  if (target === messages) {
    messages.scrollTop = container.offsetHeight > messages.clientHeight
      ? messages.scrollHeight - container.offsetHeight - 16 : messages.scrollHeight
  }
}

async function chat(task, text, profile, target = messages) {
  if (busy) return
  if (target === messages) addStudent(text)
  else target.replaceChildren(element('p', 'loading', 'Compass AI가 답변을 준비하고 있어요.'))
  setBusy(true)
  try {
    const response = await api('chat', { task, text, profile }).then(res => res.json())
    if (target !== messages) target.replaceChildren()
    addReply(target, response)
    if (task === 'topics' && response.topics?.length === 3) progress(1)
    if (task === 'design' && !response.safety) progress(3)
    if (task === 'evaluate' && response.reviews) progress(3)
    return response
  } catch (error) {
    if (target !== messages) target.replaceChildren()
    showError(target, error.message)
    if (target === messages) messages.scrollTop = messages.scrollHeight
  } finally {
    setBusy(false)
  }
}

profileForm.addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(profileForm)
  const profile = {
    grade: data.get('grade'), career: data.get('career').trim(), interests: data.get('interests').trim(),
    places: data.getAll('place'), period: data.get('period')
  }
  const error = byId('profile-error')
  error.hidden = Boolean(profile.places.length)
  if (!profile.places.length) {
    error.textContent = '탐구 장소를 한 곳 이상 선택해 주세요.'
    profileForm.querySelector('[name=place]').focus()
    return
  }
  panel('chat')
  const text = [
    '학년 · ' + profile.grade, '진로 희망 · ' + profile.career, '관심사 · ' + profile.interests,
    '탐구 장소 · ' + profile.places.join(', '), '기간 · ' + profile.period
  ].join('\n')
  chat('topics', text, profile)
})

profileForm.addEventListener('reset', () => { byId('profile-error').hidden = true })

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    const field = byId('interests')
    const existing = field.value.split(',').map(item => item.trim()).filter(Boolean)
    const updated = [...new Set([...existing, chip.textContent])].join(', ')
    if (updated.length <= field.maxLength) field.value = updated
    field.focus()
  })
}

byId('message-form').addEventListener('submit', event => {
  event.preventDefault()
  const field = byId('question')
  const text = field.value.trim()
  if (!text || busy) return
  if (/(논문|openalex).{0,20}(찾아|검색)|(?:찾아|검색).{0,20}(논문|openalex)/i.test(text)) {
    paperQuery.value = (text.length > 200 && topic ? topic : text).slice(0, 200)
    panel('papers')
    paperQuery.focus()
    updateSuggestions(0)
    return
  }
  chat('chat', text).then(response => { if (response && field.value.trim() === text) field.value = '' })
})
byId('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    if (!busy) byId('message-form').requestSubmit()
  }
})

byId('reset-chat').addEventListener('click', async () => {
  if (busy) return
  setBusy(true)
  try {
    await api('session', undefined, 'DELETE')
    session = crypto.randomUUID()
    topic = ''
    planSuggestion = ''
    planSuggestionFor = ''
    messages.replaceChildren(welcome.cloneNode(true))
    searchResults.replaceChildren()
    planResults.replaceChildren()
    byId('question').value = ''
    clearSuggestions()
    suggestionCache.clear()
    paperForm.reset()
    byId('plan-form').reset()
    progress(0, true)
  } catch (error) {
    showError(messages, error.message)
  } finally {
    setBusy(false)
  }
})

function clearSuggestions() {
  clearTimeout(suggestionsTimer)
  suggestionsRequest?.abort()
  suggestionsRequest = undefined
  suggestionsList.replaceChildren()
  suggestionsPanel.hidden = true
  suggestionsStatus.textContent = ''
}

function showSuggestions(queries) {
  suggestionsPanel.hidden = queries.length === 0
  suggestionsStatus.textContent = queries.length ? '' : '입력한 주제로 바로 검색할 수 있어요.'
  for (const query of queries) {
    const item = element('li')
    const button = element('button', '', query)
    button.type = 'button'
    button.lang = 'en'
    button.addEventListener('click', () => {
      if (busy) return
      paperQuery.value = query
      paperQuery.focus()
      paperForm.requestSubmit()
    })
    item.append(button)
    suggestionsList.append(item)
  }
}

function updateSuggestions(delay = 800) {
  clearSuggestions()
  const query = paperQuery.value.trim()
  if (query.length < 3 || busy) return
  const cached = suggestionCache.get(query)
  if (cached) {
    showSuggestions(cached)
    return
  }
  suggestionsTimer = setTimeout(async () => {
    if (busy) return
    const request = new AbortController()
    suggestionsRequest = request
    suggestionsStatus.textContent = '학술 검색어를 추천하고 있어요…'
    try {
      const result = await api('papers/suggestions', { query }, 'POST', request.signal).then(res => res.json())
      if (request.signal.aborted) return
      const queries = Array.isArray(result.queries) ? result.queries : []
      if (queries.length) suggestionCache.set(query, queries)
      showSuggestions(queries)
    } catch {
      if (!request.signal.aborted) suggestionsStatus.textContent = '추천 검색어를 불러오지 못했어요. 입력한 주제로 바로 검색할 수 있어요.'
    }
  }, delay)
}

paperQuery.addEventListener('input', event => {
  if (!event.isComposing) updateSuggestions()
  else clearSuggestions()
})
paperQuery.addEventListener('compositionend', () => updateSuggestions())
paperForm.addEventListener('keydown', event => {
  if (event.isComposing) return
  const buttons = [...suggestionsList.querySelectorAll('button')]
  const index = buttons.indexOf(event.target)
  if (event.key === 'Escape' && (!suggestionsPanel.hidden || suggestionsStatus.textContent)) {
    clearSuggestions()
    if (index >= 0) paperQuery.focus()
  } else if (buttons.length && (index >= 0 || event.target === paperQuery)) {
    const next = event.key === 'ArrowDown' ? buttons[index + 1] : event.key === 'ArrowUp' && index >= 0
      ? (buttons[index - 1] || paperQuery) : null
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }
})

function addPaper(result) {
  const card = element('article', 'paper')
  const title = element('h3', '', result.title)
  const authors = result.authors.join(', ') + (result.moreAuthors ? ' 외' : '')
  card.append(title, element('p', 'metadata', (authors || '저자 정보 없음') + ' · ' + (result.year || '연도 정보 없음')))
  const link = element('a', 'metadata', result.doi ? 'DOI ' + result.doi.slice('https://doi.org/'.length) : 'OpenAlex에서 보기')
  link.href = result.doi || result.id
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  const source = element('p')
  source.append(link)
  card.append(source)
  if (result.finding) card.append(element('p', '', result.finding))
  if (result.relevance) card.append(element('p', '', '탐구 주제와의 관련성 · ' + result.relevance))
  if (result.abstract) {
    const details = element('details')
    details.append(element('summary', '', 'OpenAlex 초록 보기'), element('p', '', result.abstract))
    card.append(details)
  } else {
    card.append(element('p', 'metadata', 'OpenAlex에 초록이 등록되어 있지 않습니다.'))
  }
  searchResults.append(card)
}

paperForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (busy) return
  const query = paperQuery.value.trim()
  if (!query) return
  clearSuggestions()
  setBusy(true)
  searchResults.replaceChildren(element('p', 'loading', 'OpenAlex에서 실제 논문을 찾고 있어요.'))
  try {
    const response = await api('papers', { query, recent: byId('recent').checked }).then(res => res.json())
    searchResults.replaceChildren()
    if (response.message) {
      searchResults.append(element('p', '', response.message))
      return
    }
    if (!response.papers.length) {
      searchResults.append(element('p', '', '일치하는 논문이 없어요. 짧은 영어 학술 키워드로 다시 검색해 보세요.'))
      return
    }
    const subtitle = `검색어 · ${response.query}${response.from ? ' / ' + response.from + ' 이후' : ''}`
    searchResults.append(element('p', 'metadata', subtitle))
    for (const paper of response.papers) addPaper(paper)
    progress(2)
  } catch (error) {
    searchResults.replaceChildren()
    showError(searchResults, error.message)
  } finally {
    setBusy(false)
  }
})

function planData() {
  return { title: byId('plan-title').value.trim(), student: byId('plan-body').value.trim() }
}

for (const button of document.querySelectorAll('[data-plan-task]')) {
  button.addEventListener('click', async () => {
    if (busy || !byId('plan-form').reportValidity()) return
    const task = button.dataset.planTask
    const { title, student } = planData()
    const content = [title, student].join('\n\n')
    const reply = await chat(task, content, undefined, planResults)
    if (task === 'plan' && reply?.text && !reply.safety) {
      planSuggestion = reply.text
      planSuggestionFor = content
    }
  })
}

byId('plan-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = byId('pdf-button')
  if (button.disabled) return
  const { title, student } = planData()
  const ai = [title, student].join('\n\n') === planSuggestionFor ? planSuggestion : ''
  button.disabled = true
  try {
    const pdf = await api('pdf', { title, student, ai }).then(response => response.blob())
    const url = URL.createObjectURL(pdf)
    const download = element('a')
    download.href = url
    download.download = 'bio-compass-plan.pdf'
    document.body.append(download)
    download.click()
    download.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    progress(4)
  } catch (error) {
    showError(planResults, error.message)
  } finally {
    button.disabled = false
  }
})
