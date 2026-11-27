import { readFileSync } from 'node:fs'

export const workspacePrompt = readFileSync(new URL('./workspace-prompt.md', import.meta.url), 'utf8')
export const places = ['학교 과학실', '집에서 간단한 실험', '컴퓨터 분석만']
export const periods = ['1~2주', '한 달', '한 학기']
const grades = ['고1', '고2', '고3']
export const criteria = ['교육과정 연계성', '과학적 정확성', '탐구 설계 및 검증 가능성', '실현 가능성', '안전 및 윤리']

export class PublicError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function clean(value, max) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max) : ''
}

export function input(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new PublicError(400, `내용을 입력해 주세요. 최대 ${max}자까지 입력할 수 있어요.`)
  }
  const result = clean(value, max)
  if (/(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+82[ -]?)?(?:010|011|016|017|018|019)[ -]?\d{3,4}[ -]?\d{4}|\b\d{6}-[1-4]\d{6}\b|(?:이름|학교|연락처)\s*[:：])/i.test(result)) {
    throw new PublicError(400, '이름, 학교, 연락처 등 개인정보를 지운 뒤 다시 보내 주세요.')
  }
  return result
}

export function profileMessage(profile) {
  if (!profile || !grades.includes(profile.grade) || !periods.includes(profile.period) ||
    !Array.isArray(profile.places) || !profile.places.length || profile.places.length > 3 ||
    profile.places.some(place => !places.includes(place))) {
    throw new PublicError(400, '학년, 탐구 장소, 기간을 선택해 주세요.')
  }
  return [
    `학년: ${profile.grade}`,
    `진로 희망 분야: ${input(profile.career, 100)}`,
    `최근 관심사와 키워드: ${input(profile.interests, 240)}`,
    `탐구 장소: ${[...new Set(profile.places)].join(', ')}`,
    `탐구 기간: ${profile.period}`
  ].join('\n')
}

const dangerous = /(?:(?:병원체|병원성|독소|탄저|보툴리눔|바이러스|세균|미생물).{0,35}(?:배양|증식|변형|전파|유전자[\s-]*편집|회피)|(?:배양|증식|변형|전파|유전자[\s-]*편집|회피).{0,35}(?:병원체|병원성|독소|탄저|보툴리눔|바이러스|세균|미생물)|(?:pathogen|viru[ss]|bacteria|toxin|anthrax|botulin).{0,40}(?:cultur|grow|modif|engineer|disseminat|evad|synthesi)|(?:cultur|grow|modif|engineer|disseminat|evad|synthesi).{0,40}(?:pathogen|viru[ss]|bacteria|toxin|anthrax|botulin))/is
export const safeReply = '그 활동은 감염이나 생물안전 문제를 일으킬 수 있어 구체적인 실행 방법은 안내할 수 없어요. 공개된 자료로 감염 추이를 비교하거나, 식용 식물의 발아율을 비교하는 탐구로 바꿔 볼까요?'
export const needsSafetyRedirect = text => dangerous.test(text)

const paperQueryInstruction = '학생에게 보여 줄 쉬운 한국어 검색어 label과, OpenAlex에 보낼 같은 뜻의 영어 검색어 query를 한 쌍으로 3개 추천한다. label은 한국어로 된 짧은 구절, query는 자연스러운 영어 학술 검색어 2~7개 단어로 작성한다. 핵심 개념, 관련 기전, 연구 방법 등 서로 다른 관점을 고른다. 논문 제목이나 DOI는 만들지 않는다. 위험하거나 안전하지 않은 생물학 연구에 대한 구체적인 방법과 이를 찾는 검색어는 제시하지 않는다.'

export function normalizePaperSuggestions(values) {
  if (!Array.isArray(values)) return []
  const suggestions = []
  const seenQueries = new Set()
  const seenLabels = new Set()
  for (const value of values) {
    const label = clean(value?.label, 80).replace(/\s+/g, ' ')
    const query = clean(value?.query, 100).replace(/\s+/g, ' ')
    if (!/[가-힣]/.test(label) || !/^[a-z0-9-]+(?: [a-z0-9-]+){1,6}$/i.test(query) || !/[a-z]/i.test(query)) continue
    if (needsSafetyRedirect(label) || needsSafetyRedirect(query) || seenQueries.has(query.toLowerCase()) || seenLabels.has(label)) continue
    suggestions.push({ label, query })
    seenQueries.add(query.toLowerCase())
    seenLabels.add(label)
    if (suggestions.length === 3) break
  }
  return suggestions
}

const formats = {
  chat: '학생의 질문에 바로 답한다. 어려운 개념은 쉬운 말로 설명한다. 논문을 찾으려는 학생에게는 논문 검색 탭에서 주제를 입력하고 추천 검색어를 고르거나 검색 버튼을 누르는 방법을 안내한다.',
  paperQueries: paperQueryInstruction + ' JSON 객체만 출력한다. {"suggestions":[{"label":"","query":""}]}',
  topics: paperQueryInstruction + ' 각 주제의 searchSuggestions 배열에 넣는다. 각 주제는 학생의 관심사와 여건에 맞추고 추천 이유는 학생이 이해할 수 있는 한두 문장으로 설명한다. 검색 상태, 도구 유무, 성취기준 번호를 카드에 쓰지 않는다. 다음 JSON만 출력한다. {"topics":[{"kind":"literature","title":"","question":"","concepts":"","reason":"","difficulty":"","searchSuggestions":[{"label":"","query":""}]},{"kind":"experiment","title":"","question":"","concepts":"","reason":"","difficulty":"","searchSuggestions":[{"label":"","query":""}]},{"kind":"data","title":"","question":"","concepts":"","reason":"","difficulty":"","searchSuggestions":[{"label":"","query":""}]}]}',
  design: '가설, 변인 또는 비교 기준, 준비물, 방법, 자료 수집과 분석, 기간, 안전을 Markdown 제목과 표로 정리한다. 실제 데이터를 넣지 않는다.',
  evaluate: `다음 JSON만 출력한다. {"summary":"종합 의견","reviews":[{"criterion":"","score":null,"evidence":"","strength":"","improvement":""}]}. criterion은 다음 순서와 표기를 지킨다. ${criteria.join(' / ')}. 각각 한 번씩 쓴다. 평가 기준표가 검색되면 항목당 1~4점을 부여한다. 정보가 부족하면 score는 null로 두고 해당 평가를 보류한다. summary에는 안전 판정, 출처 유무, 점수 부여가 가능한 경우 총점과 종합 판정, 우선 수정 사항을 포함한다. 안전상 수행 불가인 실험을 승인하지 않는다.`,
  plan: '학생이 입력한 초안을 근거로 첫 단계부터 끝까지 계획에 도움이 될 AI 제안만 Markdown으로 정리한다. 학생의 원문은 복사하지 않는다. 자료 수집 전의 실험 결과는 쓰지 않는다.'
}

export function buildPrompt(task, text) {
  return `[학생이 입력한 내용]\n${text}\n\n[Compass AI 응답 형식]\n${formats[task]}\n자료 근거와 AI 제안을 분리한다. 학생에게 보이는 화면이나 도구의 연결 상태를 추측해 말하지 않는다. 주제 추천과 검색어 추천은 논문을 검색하기 전 단계다. 실제 검색의 성공, 실패 또는 결과는 확인된 정보가 있을 때만 설명한다. 위험한 실험 방법, 확인되지 않은 출처, 가짜 데이터는 제공하지 않는다.`
}

export function parseObject(text) {
  const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const value = JSON.parse(withoutFence)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function structuredReply(task, text) {
  const raw = parseObject(text)
  if (task !== 'topics' && task !== 'evaluate') return { text }
  if (task === 'topics') {
    const topics = ['literature', 'experiment', 'data'].map(kind => {
      const row = Array.isArray(raw?.topics) && raw.topics.find(topic => topic?.kind === kind)
      if (!row) return null
      const typed = { kind }
      for (const key of ['title', 'question', 'concepts', 'reason', 'difficulty']) typed[key] = clean(row[key], 650)
      if (!Object.values(typed).every(Boolean)) return null
      const searchSuggestions = normalizePaperSuggestions(row.searchSuggestions)
      return { ...typed, searchSuggestions, searchQueries: searchSuggestions.map(({ query }) => query) }
    })
    return topics.every(Boolean) ? { text: '', topics } : { text: '주제 추천을 마치지 못했어요. 맞춤 탐구 시작하기를 다시 눌러 주세요.' }
  }
  if (!raw) return { text }
  const summary = clean(raw.summary, 2000)
  const reviews = criteria.map(criterion => {
    const row = Array.isArray(raw.reviews) && raw.reviews.find(review => review?.criterion === criterion)
    return row && {
      criterion,
      score: Number.isInteger(row.score) && row.score >= 1 && row.score <= 4 ? row.score : null,
      evidence: clean(row.evidence, 1500),
      strength: clean(row.strength, 1500),
      improvement: clean(row.improvement, 1500)
    }
  })
  return reviews.every(row => row?.strength && row.improvement)
    ? { text: summary, reviews }
    : { text: '계획서 평가를 마치지 못했어요. 계획서 평가 버튼을 다시 눌러 주세요.' }
}
