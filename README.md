# Bio Compass

고등학생을 위한 한국어 생명과학 탐구 설계 도우미입니다. 프로필을 바탕으로 주제를 찾고, 실제 논문을 확인한 뒤 탐구를 설계하고 계획서를 PDF로 저장합니다.

## 전체 구조

| 구성 | 역할 |
| --- | --- |
| 웹 화면 | 학생 프로필, 단계 표시, 대화, 논문 카드, 계획서 평가 및 PDF |
| Bio Compass 서버 | 입력 검증, 호출 빈도 제한, 학생별 대화 분리, PDF 생성 |
| AnythingLLM | 수업에서 정한 OpenAI 모델, 시스템 프롬프트, 참고 자료 검색 |
| OpenAlex | 실제 논문 메타데이터와 초록 제공 |

웹페이지는 Bio Compass 서버에만 요청합니다. 서버가 AnythingLLM과 OpenAlex에 연결하고, API 키는 서버에서 사용합니다.

## 내 컴퓨터에서 실행하기

Node.js 24를 설치한 뒤 이 폴더에서 아래 명령을 입력합니다.

```sh
npm ci
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. 키가 준비되기 전에는 AI 설정 필요 상태를 표시합니다. 이 상태에서도 OpenAlex 검색과 직접 작성한 계획서 PDF를 이용할 수 있습니다.

## AnythingLLM 설정

1. AnythingLLM 관리자 페이지에 로그인합니다. Railway 설치라면 **AnythingLLM → Variables → AUTH_TOKEN**의 설정값을 로그인 화면에 붙여넣습니다.
2. 기존 작업방을 재사용하는 경우 주소에서 `/workspace/` 뒤의 값이 연결 이름입니다. Bio Compass의 기존 작업방은 `biocompass`입니다. 새로운 설치에서 `bio-compass`를 쓰는 경우 환경변수도 같은 값으로 설정합니다.
3. 작업방 **채팅 설정**에서 **OpenAI → gpt-6.2-sol**을 선택하고 수업 Padlet 키를 입력합니다. Temperature에는 **0.7**을 입력합니다. [시스템 프롬프트](server/workspace-prompt.md)를 붙여넣고 저장합니다. 키는 채팅, 소스코드, GitHub에 붙여넣지 않습니다.
4. 첫 임베딩 전에 **설정 → Text Splitter & Chunking**에서 크기 **1000**, 겹침 **200**을 저장합니다. 작업방 **Vector Database**에서 **Accuracy Optimized**, 최대 문맥 조각 **4**, 문서 유사도 **Medium**을 선택합니다. Accuracy Optimized는 이 버전에서 LanceDB를 사용합니다.
5. `multilingual-e5-small`은 한국어와 영어를 함께 처리할 수 있는 모델입니다. 현재 서비스의 기본 내장 임베딩 모델 목록에서 선택할 수 있는지 먼저 확인합니다. 선택할 수 없다면 현재 임베더로 검색 품질을 확인하거나 수업에서 승인한 다국어 임베딩 서비스에 연결합니다. 임베딩 모델을 바꾸면 동일한 모델로 검색이 가능하도록 문서 4개를 다시 임베딩합니다.
6. 수업 자료 `교육과정_생명과학.md`, `탐구설계_가이드.md`, `탐구평가_기준표.md`, `실험안전_윤리.md`를 업로드하고 네 파일을 선택한 뒤 **Move to Workspace → Save and Embed**를 누릅니다.
7. **설정 → 도구 → 개발자 API**에서 이 웹사이트용 키를 만듭니다. 테스트할 때만 사용하는 임시 작업방과 기존 학생 대화를 구분합니다.

## OpenAlex Agent Flow

**설정 → Agent Skills → Agent Flows**에서 `OpenAlex`를 만듭니다. [Flow 설정 예시](anythingllm/openalex-flow.json)에 이름, 설명, 변수와 블록이 있습니다.

| 단계 | 설정 |
| --- | --- |
| Start | 학생 질문 변수 `studentQuestion`을 필수 입력으로 두고 `searchKeywords`, `OpenAlexResults`를 둡니다. |
| LLM Instruction | 안전한 질문을 영어 키워드 2~4개로 바꾸고 `+`로 연결합니다. 저장 변수는 `searchKeywords`입니다. |
| API Call | GET으로 OpenAlex에서 최대 5개를 가져옵니다. 결과 저장 변수는 `OpenAlexResults`입니다. |
| LLM Instruction | 결과에 있는 제목, 저자, 연도, DOI, 초록 근거와 관련성을 한국어로 설명합니다. 마지막 블록의 출력이 도구 결과가 됩니다. |

저장 후 Flow를 켜고 AnythingLLM 채팅에서 `@agent 빛과 무순 발아 관련 논문을 찾아줘`로 테스트합니다. 환경에 따라 작업방의 에이전트 모델 설정에도 수업에서 지정한 모델을 선택해야 합니다.

이 버전의 학생용 대화 스레드 API 명세에는 Flow를 직접 실행하는 엔드포인트가 없습니다. 웹페이지의 **논문 검색** 탭은 Bio Compass 서버가 OpenAlex를 직접 조회합니다. 앱 서버의 `OPENALEX_API_KEY`를 등록하면 서버 요청에 사용됩니다. 키 없이 동작하는 범위는 OpenAlex의 사용량 정책을 따릅니다. Agent Flow에서도 같은 키를 쓰려면 웹 서비스가 실행된 후 API Call의 URL을 `http://bio-compass.railway.internal:<포트>/api/papers?q=${searchKeywords}`로 바꿀 수 있습니다. 두 서비스가 같은 Railway 사설 네트워크에 있어야 합니다. 프로젝트가 다르면 관리자만 정한 HTTPS 서버 주소를 사용합니다. 키를 Flow URL에 붙여넣지 않습니다.

웹에서 최근 5년을 선택하면 검색일 기준으로 날짜를 계산합니다. 연결 서버 검색에는 `recent=1`을 붙일 수 있고, OpenAlex를 직접 사용하는 Flow에서는 기존 `filter` 값 뒤에 `,from_publication_date:YYYY-MM-DD`를 추가하고 날짜를 갱신합니다.

## 환경변수와 Railway

내 컴퓨터에서는 `.env.example`을 `.env`로 복사해서 채우고, Railway에서는 **sweet-enchantment → bio-compass → Variables**에 아래 값을 추가합니다.

| 변수 | 값 |
| --- | --- |
| `ANYTHINGLLM_URL` | 기존 AnythingLLM의 HTTPS 주소. 뒤에 `/workspace/…`는 생략합니다. |
| `ANYTHINGLLM_WORKSPACE_SLUG` | 기존 작업방의 `biocompass` |
| `ANYTHINGLLM_API_KEY` | 기존 AnythingLLM 설정에서 발급한 Developer API 키 |
| `BIO_COMPASS_AI_ENABLED` | 수업 모델과 키를 확인한 후 `true` |
| `OPENALEX_API_KEY` | OpenAlex 키. 학교에서 제공하거나 사용자 계정에서 발급한 경우 입력합니다. |
| `BIO_COMPASS_AI_DAILY_LIMIT` | 웹 서비스 프로세스당 하루 AI 호출 상한. 기본 40회입니다. |
| `TRUST_PROXY_HOPS` | Railway에서 프록시 한 대를 신뢰하는 설정인 `1`. 내 컴퓨터에서는 기본 `0`. |
| `PORT` | Railway가 할당하는 포트. 로컬 기본값은 3000입니다. |

Railway에는 **hsb297777/bio-compass** 저장소를 연결합니다. 웹 공개 시에는 승인받은 브랜치를 배포하고 **Settings → Networking → Generate Domain**을 선택합니다. `Dockerfile`과 `railway.json`이 실행과 상태 확인을 정의합니다. AnythingLLM의 자료 영구 보관에는 `/storage` 볼륨이 필요합니다. 앱과 AnythingLLM의 Serverless 설정은 각 서비스 **Settings**에서 볼 수 있습니다.

웹 서비스는 학생 이름·학교·연락처를 받는 입력란이 없습니다. 대화는 탭마다 분리하고 AnythingLLM에 임시 스레드를 만들며, 초기화 또는 웹 서버가 켜진 상태에서 1시간 이상 사용하지 않은 세션을 정리합니다. 프로세스가 중단되면 미정리 스레드가 AnythingLLM에 남을 수 있으므로 운영 시 관리자 대화 기록을 주기적으로 확인합니다. 프로세스 호출 한도도 재시작하면 초기화되므로 운영 비용의 상한은 제공자와 Railway에서 별도로 관리합니다.

## 오류와 테스트

- **AI 설정 필요**가 보이면 환경변수와 수업 모델 설정을 확인합니다. **연결 점검 필요**가 뜨면 AnythingLLM 주소의 `/api/ping`, 작업방 slug, Developer API 키를 확인합니다. 앱 연결 상태는 키와 작업방 접근을 확인하며, 실제 모델 응답은 채팅으로 테스트합니다.
- 논문 카드가 없으면 짧은 영어 검색어로 다시 검색합니다. DOI가 없는 결과는 OpenAlex 링크를 표시합니다. 초록이 없는 경우 연구 내용 확인에 한계가 표시됩니다.
- 자료 제목은 답변의 **참고 자료**에서 확인합니다. 평가 기준표를 직접 인용하는 질문도 확인합니다. 모델 설정 뒤에는 문헌·실험·데이터 주제, 학년과 기간에 맞는 변수 설계, 위험 실험 안전 안내, 루브릭 평가를 순서대로 확인합니다.
- 개발 검증은 `npm test`로 실행합니다. AnythingLLM 요청 경로, 세션 분리와 초기화, 키 노출 방지, 위험 입력 차단, 한국어 PDF를 검사합니다. 테스트 대역을 사용하므로 실제 모델과 RAG 답변은 별도로 검증해야 합니다.
- 관리자 주소에서 Railway 404가 보이면 AnythingLLM의 **Deployments** 탭에서 실행 상태를 확인합니다. 자료가 들어 있는 볼륨을 유지한 채 복구합니다.
