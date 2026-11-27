const byId = id => document.getElementById(id)
const md = window.markdownit?.({ html: false, linkify: true })
const profileForm = byId('profile-form')
const planForm = byId('plan-form')
const planKind = byId('plan-kind')
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
let selectedPaperSuggestion
let originalPaperQuestion
const planResults = byId('plan-results')
const welcome = messages.firstElementChild.cloneNode(true)
const kindNames = { literature: '문헌 탐구형', experiment: '실험 탐구형', data: '데이터 분석형' }
const taskProgress = {
  topics: '프로필에 맞는 탐구 주제를 추천하고 있어요.',
  design: '탐구 질문과 방법을 정리하고 있어요.',
  evaluate: '계획서를 읽고 평가하고 있어요.',
  plan: '계획서에 넣을 제안을 정리하고 있어요.'
}
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

function setBusy(value, message) {
  busy = value
  for (const node of document.querySelectorAll('#profile-submit, #send, #reset-chat, [data-plan-task], #search-button')) node.disabled = value
  const loading = byId('loading')
  loading.hidden = !value || byId('chat').hidden
  if (value) loading.textContent = message || 'Compass AI가 답변을 준비하고 있어요.'
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
  const labels = { connected: 'AI 연결됨', unavailable: 'AI 연결 지연', unconfigured: 'AI 이용 불가' }
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
  details.append(element('summary', '', '이 답변에 참고한 자료'))
  const list = element('ul')
  for (const name of sources) list.append(element('li', '', name))
  details.append(list)
  container.append(details)
}

function curriculumLabel(standard) {
  return `${standard.subject} / ${standard.unit} (${standard.code})`
}

function addCurriculum(container, standard, heading) {
  if (!standard) return
  const block = element('section', 'curriculum')
  const source = element('a', 'metadata', '교육부 교육과정 원문')
  source.href = standard.source
  source.target = '_blank'
  source.rel = 'noopener noreferrer'
  block.append(element('h4', '', heading), element('p', '', curriculumLabel(standard)),
    element('p', '', '교과 개념: ' + standard.concept),
    element('p', '', '이 주제에 쓰는 방법: ' + standard.reason), source)
  container.append(block)
}

function addTopics(container, topics) {
  container.append(element('p', '', '관심 있는 주제에서 ‘이 주제 선택’을 누르면 논문 검색창으로 이동해요. 추천 검색어를 누르거나 검색 버튼을 눌러 논문을 찾아보세요.'))
  const group = element('div', 'topic-list')
  for (const option of topics) {
    if (option.searchSuggestions?.length) {
      suggestionCache.set(option.title.slice(0, 200).trim(), option.searchSuggestions)
      suggestionCache.set(option.question.slice(0, 200).trim(), option.searchSuggestions)
    }
    const card = element('article', 'topic')
    card.append(element('p', 'topic-kind', kindNames[option.kind]),
      element('h3', '', option.title),
      element('p', '', '탐구 질문: ' + option.question),
      element('p', '', '관련 개념: ' + option.concepts),
      element('p', '', '추천 이유: ' + option.reason),
      element('p', '', '난이도: ' + option.difficulty))
    addCurriculum(card, option.curriculum, '교육과정 연결')
    const select = element('button', 'button secondary', '이 주제 선택')
    select.type = 'button'
    select.addEventListener('click', () => {
      if (busy) return
      topic = option.title
      openPaperSearch(option.title, option.question)
      const title = byId('plan-title')
      if (!title.value) {
        title.value = option.title.slice(0, 180)
        setPlanCurriculum(option.curriculum)
        if (!planKind.value) planKind.value = option.kind
        updatePlanType()
      }
    })
    card.append(select)
    group.append(card)
  }
  container.append(group)
}

function addReply(target, response, task) {
  const container = element('article', 'message')
  if (!response.safety && (task === 'plan' || task === 'design')) {
    container.append(element('h3', 'message-title', task === 'plan' ? '탐구 계획 보완' : '탐구 설계'),
      element('p', 'ai-note', '(AI 제안)'))
  } else {
    container.append(element('p', 'message-title', response.safety ? '안전 안내' : 'Compass AI'))
  }
  if (response.text) container.append(markdown(response.text))
  if (response.topics) addTopics(container, response.topics)
  if (response.reviews) {
    const group = element('div', 'topic-list')
    for (const review of response.reviews) {
      const card = element('section', 'review')
      const score = review.score === undefined ? '' : review.score === null ? ': 추가 정보 필요' : ': ' + review.score + '점'
      card.append(element('h3', '', review.criterion + score),
        element('p', '', '잘한 점: ' + review.strength),
        element('p', '', '개선 방향: ' + review.improvement))
      if (review.evidence) card.append(element('p', '', '평가 근거: ' + review.evidence))
      group.append(card)
    }
    container.append(group)
  }
  addCurriculum(container, response.curriculum, '교육과정 연결 제안')
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
  else target.replaceChildren(element('p', 'loading', taskProgress[task]))
  setBusy(true, taskProgress[task])
  try {
    const response = await api('chat', { task, text, profile }).then(res => res.json())
    if (target !== messages) target.replaceChildren()
    addReply(target, response, task)
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
    '학년: ' + profile.grade, '진로 희망: ' + profile.career, '관심사: ' + profile.interests,
    '탐구 장소: ' + profile.places.join(', '), '기간: ' + profile.period
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
    openPaperSearch(text.length > 200 && topic ? topic : text)
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
  setBusy(true, '대화를 초기화하고 있어요.')
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
    selectedPaperSuggestion = undefined
    originalPaperQuestion = undefined
    paperForm.reset()
    planForm.reset()
    setPlanCurriculum()
    for (const [index, step] of [...planForm.querySelectorAll('.plan-step')].entries()) step.open = index === 0
    updatePlanType()
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

function openPaperSearch(text, question) {
  selectedPaperSuggestion = undefined
  originalPaperQuestion = question?.slice(0, paperQuery.maxLength)
  paperQuery.value = text.slice(0, paperQuery.maxLength)
  searchResults.replaceChildren()
  panel('papers')
  paperQuery.focus()
  updateSuggestions(0)
}

function showSuggestions(suggestions) {
  suggestionsPanel.hidden = suggestions.length === 0
  suggestionsStatus.textContent = suggestions.length ? '' : '입력한 주제로 바로 검색할 수 있어요.'
  for (const suggestion of suggestions) {
    const item = element('li')
    const button = element('button', '', suggestion.label)
    button.type = 'button'
    button.addEventListener('click', () => {
      if (busy) return
      selectedPaperSuggestion = { ...suggestion, topic: originalPaperQuestion || paperQuery.value.trim() }
      paperQuery.value = suggestion.label
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
    suggestionsStatus.textContent = '논문을 찾을 때 쓸 검색어를 준비하고 있어요…'
    try {
      const result = await api('papers/suggestions', { query }, 'POST', request.signal).then(res => res.json())
      if (request.signal.aborted) return
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions : []
      if (suggestions.length) suggestionCache.set(query, suggestions)
      showSuggestions(suggestions)
    } catch {
      if (!request.signal.aborted) suggestionsStatus.textContent = '추천 검색어를 불러오지 못했어요. 현재 입력한 내용으로 검색하려면 검색 버튼을 눌러 주세요.'
    }
  }, delay)
}

paperQuery.addEventListener('input', event => {
  selectedPaperSuggestion = undefined
  originalPaperQuestion = undefined
  searchResults.replaceChildren()
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
  card.append(title, element('p', 'metadata', '저자: ' + (authors || '정보 없음') + ' / 연도: ' + (result.year || '정보 없음')))
  const link = element('a', 'metadata', result.doi ? 'DOI ' + result.doi.slice('https://doi.org/'.length) : 'OpenAlex에서 보기')
  link.href = result.doi || result.id
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  const source = element('p')
  source.append(link)
  card.append(source)
  const ratings = {
    direct: { score: 3, label: '핵심 자료로 참고' },
    background: { score: 2, label: '배경 설명에 참고' },
    skip: { score: 1, label: '이 질문에서는 건너뛰기' },
    check: { score: null, label: '원문 확인 후 판단' }
  }
  const reading = result.reading
  const fit = reading?.fit || 'check'
  const { score, label } = ratings[fit]
  const verdict = element('p', 'paper-verdict')
  verdict.dataset.fit = fit
  if (score === null) {
    verdict.textContent = '활용도 미정: ' + label
  } else {
    const stars = element('span', 'paper-stars')
    stars.setAttribute('aria-hidden', 'true')
    stars.append(element('span', 'paper-star-filled', '★'.repeat(score)),
      element('span', 'paper-star-empty', '☆'.repeat(3 - score)))
    verdict.append(element('span', 'visually-hidden', `활용도 별 3개 중 ${score}개. `),
      stars, document.createTextNode(' ' + label))
  }
  card.append(verdict)
  if (result.finding) card.append(element('p', '', result.finding))
  if (reading?.relevance) card.append(element('p', '', '연결 이유: ' + reading.relevance))
  if (reading?.use) card.append(element('p', '', '어디에 쓸까: ' + reading.use))
  if (reading?.caution) card.append(element('p', '', '읽을 때 확인할 점: ' + reading.caution))
  if (!reading) card.append(element('p', '', '원문에서 내 질문과 같은 대상이나 결과를 다루는지 먼저 확인해 보세요.'))
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
  const displayQuery = paperQuery.value.trim()
  if (!displayQuery) return
  const picked = selectedPaperSuggestion?.label === displayQuery ? selectedPaperSuggestion : undefined
  clearSuggestions()
  paperQuery.readOnly = true
  setBusy(true)
  searchResults.replaceChildren(element('p', 'loading', 'OpenAlex에서 실제 논문을 찾고 있어요.'))
  try {
    const response = await api('papers', { query: picked?.query || displayQuery, topic: picked?.topic || originalPaperQuestion, recent: byId('recent').checked }).then(res => res.json())
    searchResults.replaceChildren()
    if (response.message) {
      searchResults.append(element('p', '', response.message))
      return
    }
    if (!response.papers.length) {
      searchResults.append(element('p', '', '이 검색어로 찾은 논문이 없어요. 핵심 단어 두세 개로 줄여 다시 검색해 보세요.'))
      return
    }
    const subtitle = `검색어: ${displayQuery}${response.from ? ' / ' + response.from + ' 이후' : ''}`
    searchResults.append(element('p', 'metadata', subtitle),
      element('p', 'metadata', '채워진 별이 많을수록 내 탐구 질문에 직접 도움이 되는 논문이에요.'))
    for (const paper of response.papers) addPaper(paper)
    progress(2)
  } catch (error) {
    searchResults.replaceChildren()
    showError(searchResults, error.message)
  } finally {
    paperQuery.readOnly = false
    setBusy(false)
  }
})

const planGuidance = {
  '': {
    expectation: ['예상 결과 또는 가설', '어떤 차이가 있을 것 같나요? 그렇게 생각한 이유도 한 줄 적어 보세요.'],
    material: ['준비물 또는 참고 자료', '사용할 도구나 자료 이름을 적어 보세요.'],
    method: '처음 할 일부터 차례대로 한 줄씩 적어 보세요.',
    analysis: '무엇을 언제 기록할지, 표나 그래프로 어떻게 비교할지 써 보세요.'
  },
  literature: {
    expectation: ['읽기 전에 예상하는 내용', '자료를 읽고 나면 어떤 공통점이나 차이를 발견할 것 같나요?'],
    material: ['찾아볼 논문과 자료', '어떤 검색어로 찾을지, 자료를 어디에서 구할지 적어 보세요. 논문을 골랐다면 제목이나 링크를 적어도 좋아요.'],
    method: '자료를 찾고, 골라서 읽고, 같은 기준으로 정리하는 순서를 적어 보세요.',
    analysis: '예: 자료마다 연구 대상, 관찰한 결과, 연구의 한계를 표로 비교해요.'
  },
  experiment: {
    expectation: ['가설', '예: 빛을 받는 시간이 달라지면 무순의 발아율도 달라질 것이다. 그렇게 예상한 이유를 덧붙여 보세요.'],
    material: ['준비물', '필요한 물건, 개수, 측정 도구를 적어 보세요.'],
    method: '무엇을 준비할지, 조건을 어떻게 나눌지, 언제 몇 번 관찰할지 차례대로 쓰세요.',
    analysis: '예: 매일 같은 시각에 싹이 난 개수를 세고, 조건별 발아율을 그래프로 비교해요.'
  },
  data: {
    expectation: ['데이터에서 예상하는 경향', '두 집단이나 기간 사이에 어떤 차이가 있을 것 같나요?'],
    material: ['사용할 공개 데이터', '데이터 이름, 제공 기관, 확인할 기간이나 지역을 적어 보세요.'],
    method: '데이터를 받을 곳, 사용할 항목, 빠진 값을 처리할 방법을 차례대로 적어 보세요.',
    analysis: '예: 두 지역의 평균이나 변화 추이를 표와 그래프로 비교해요.'
  }
}

function updatePlanType() {
  const type = planKind.value
  const guidance = planGuidance[type]
  for (const field of ['expectation', 'material']) {
    const [label, hint] = guidance[field]
    byId('plan-' + field + '-label').textContent = label
    byId('plan-' + field + '-hint').textContent = hint
  }
  byId('plan-method-hint').textContent = guidance.method
  byId('plan-analysis-hint').textContent = guidance.analysis
  byId('plan-variables').hidden = type !== 'experiment'
  byId('plan-standard-group').hidden = type === 'experiment'
  updatePlanChecklist()
}

function setPlanCurriculum(standard) {
  const hint = byId('plan-curriculum-suggest')
  hint.hidden = !standard
  hint.replaceChildren()
  if (!standard) return
  hint.append(element('strong', '', curriculumLabel(standard)),
    element('span', 'ai-note', '(AI 제안)'), document.createTextNode(standard.reason))
}

function updatePlanChecklist() {
  const comparison = planKind.value === 'experiment'
    ? ['independent', 'dependent', 'controlled']
    : ['standard']
  const fields = [
    'title', 'question', 'curriculum', 'expectation', ...comparison,
    'material', 'method', 'analysis', 'schedule', 'safety'
  ]
  const next = fields.find(id => !byId('plan-' + id).value.trim())
  const status = byId('plan-missing')
  if (!next) {
    status.textContent = '평가에 필요한 칸을 채웠어요. ‘계획서 평가’를 눌러 피드백을 받아 보세요.'
    return
  }
  const field = byId('plan-' + next)
  const label = field.labels[0].firstChild.textContent.trim()
  status.textContent = '다음에 채워 볼 칸: ' + label
}

planKind.addEventListener('change', updatePlanType)
planForm.addEventListener('input', event => {
  if (event.target.id === 'plan-title') setPlanCurriculum()
  updatePlanChecklist()
  planResults.replaceChildren()
})
planForm.addEventListener('invalid', event => {
  const step = event.target.closest('.plan-step')
  if (step) step.open = true
}, true)
for (const [id, message] of [['plan-title', '탐구 제목을 적어 주세요.'], ['plan-question', '알아보고 싶은 질문을 적어 주세요.']]) {
  const field = byId(id)
  field.addEventListener('input', () => field.setCustomValidity(field.value && !field.value.trim() ? message : ''))
  planForm.addEventListener('reset', () => field.setCustomValidity(''))
}
updatePlanType()

function planData() {
  const type = planKind.value
  const fields = [
    ['탐구 질문', byId('plan-question').value],
    ['이 주제를 고른 이유', byId('plan-reason').value],
    ['수업에서 배운 개념과 연결', byId('plan-curriculum').value],
    [planGuidance[type].expectation[0], byId('plan-expectation').value],
    ...(type === 'experiment' ? [
      ['바꿀 조건 (독립 변인)', byId('plan-independent').value],
      ['측정할 결과 (종속 변인)', byId('plan-dependent').value],
      ['같게 둘 조건 (통제 변인)', byId('plan-controlled').value]
    ] : [['비교할 대상과 기준', byId('plan-standard').value]]),
    [planGuidance[type].material[0], byId('plan-material').value],
    ['진행 순서', byId('plan-method').value],
    ['기록할 내용과 비교 방법', byId('plan-analysis').value],
    ['일정', byId('plan-schedule').value],
    ['안전과 자료 사용에서 주의할 점', byId('plan-safety').value]
  ]
  if (type) fields.unshift(['탐구 유형', kindNames[type]])
  const student = fields.filter(([, value]) => value.trim())
    .map(([label, value]) => label + '\n' + value.trim()).join('\n\n')
  return { title: byId('plan-title').value.trim(), student }
}

for (const button of document.querySelectorAll('[data-plan-task]')) {
  button.addEventListener('click', async () => {
    if (busy || !planForm.reportValidity()) return
    const task = button.dataset.planTask
    const { title, student } = planData()
    const content = [title, student].join('\n\n')
    const sections = [...planForm.querySelectorAll('fieldset')]
    sections.forEach(section => { section.disabled = true })
    try {
      const reply = await chat(task, content, undefined, planResults)
      if (task === 'plan' && reply?.text && !reply.safety) {
        planSuggestion = reply.text
        planSuggestionFor = content
      }
    } finally {
      sections.forEach(section => { section.disabled = false })
    }
  })
}

planForm.addEventListener('submit', async event => {
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
