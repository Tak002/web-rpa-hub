// 진행 세트(.wrset) 규칙: 녹화값 정리, 접속 사이트·위험 계산, 개인정보 검사, manifest·세트 검사, 기대 결과 비교.
// 의존성 없음 — web-rpa 엔진과 허브 저장소 CI 가 같은 파일을 쓴다 (허브 쪽 사본: tools/wrset/core.mjs).

export const FORMAT = 'web-rpa-set';
export const FORMAT_VERSION = 1;
export const RECIPE_SCHEMA = 1;
export const DEFAULT_LICENSE = 'CC0-1.0';
export const DEFAULT_PACING = { minRowIntervalMs: 1000, maxRowsPerRun: 200 };
export const MAX_SET_BYTES = 2 * 1024 * 1024;

// 세트에 들어갈 수 있는 파일
const ALLOWED_FILES = [/^manifest\.json$/, /^recipe\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^expected\.json$/, /^input\/sample\.csv$/, /^input\/template\.xlsx$/, /^media\/[\w.-]+\.(png|jpe?g)$/i];
const MEDIA_MAX = 500 * 1024;

// 되돌릴 수 없는 동작으로 보는 버튼 글자
const SUBMIT_WORDS = /제출|신청|신고|결제|구매|주문|삭제|발송|전송|송금|이체|확정|승인|해지|탈퇴|계약|\b(submit|pay|purchase|checkout|delete|transfer)\b/i;

// ---------------------------------------------------------------- 레시피 훑기

/** 모든 블록의 스텝을 { block, index, step } 로 */
export function* stepsOf(recipe) {
  for (const [block, steps] of Object.entries(recipe?.blocks ?? {})) {
    if (!Array.isArray(steps)) continue;
    for (let index = 0; index < steps.length; index += 1) yield { block, index, step: steps[index] };
  }
}

const where = (s) => `${s.block} 블록 ${s.index + 1}번 스텝${s.step?.id ? `(${s.step.id})` : ''}`;
const hasVar = (v) => typeof v === 'string' && v.includes('{{');

/** 주소 문자열 → origin. 변수가 호스트에 들어 있거나 웹 주소가 아니면 null */
export function originOf(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const hostPart = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  if (hostPart.includes('{{')) return null;
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).origin;
  } catch {
    return null;
  }
}

/** 레시피가 접속하는 사이트(origin) 목록 */
export function collectOrigins(recipe) {
  const set = new Set();
  const addUrl = (u) => {
    const o = originOf(u);
    if (o) set.add(o);
  };
  addUrl(recipe?.startUrl);
  for (const s of stepsOf(recipe)) {
    const st = s.step ?? {};
    if (st.type === 'navigate') addUrl(st.url);
    addUrl(st.meta?.url);
    for (const f of st.target?.framePath ?? []) addUrl(f?.url);
  }
  return [...set].sort();
}

const labelOf = (step) => [step?.target?.meta?.label, step?.target?.meta?.text, ...(step?.target?.candidates ?? []).map((c) => (typeof c.value === 'string' ? '' : c.value?.text))].filter(Boolean).join(' ');

/** 위험 표시 계산: [{ flag, where?, detail }] */
export function detectRisks(recipe) {
  const out = [];
  const push = (flag, s, detail) => out.push({ flag, where: s ? where(s) : undefined, detail });
  for (const s of stepsOf(recipe)) {
    const st = s.step ?? {};
    if (['click', 'dblclick', 'keypress', 'download'].includes(st.type) && SUBMIT_WORDS.test(labelOf(st))) push('submit', s, `"${labelOf(st).slice(0, 40)}" 을(를) 누릅니다`);
    if (st.type === 'dialog' && st.action === 'accept' && st.meta?.dialogType === 'confirm') push('submit', s, '확인창을 "확인"으로 응답합니다');
    if (['download', 'pdf', 'screenshot'].includes(st.type)) push('download', s, '파일을 저장합니다');
    if (st.type === 'upload') push('upload', s, 'PC 의 파일을 사이트에 올립니다');
    if (st.type === 'pause') push('login', s, '사용자 확인 대기가 있습니다');
    if (st.type === 'navigate' && hasVar(st.url)) {
      const [beforeQuery, query = ''] = String(st.url).split('?');
      const host = beforeQuery.replace(/^https?:\/\//i, '').split('/')[0];
      if (hasVar(host) || hasVar(query)) push('var-in-url', s, '엑셀·변수 값을 주소에 넣어 이동합니다');
    }
  }
  if ((recipe?.variables ?? []).some((v) => v?.source?.kind === 'prompt' && v.source.secret)) push('login', null, '실행할 때 비밀값(비밀번호 등)을 입력받습니다');
  for (const o of collectOrigins(recipe)) if (o.startsWith('http://')) push('insecure-http', null, `${o} 은(는) 암호화하지 않은 사이트입니다`);
  return out;
}

export const riskFlags = (risks) => [...new Set(risks.map((r) => r.flag))].sort();

// ---------------------------------------------------------------- 개인정보

const digitsOf = (s) => String(s).replace(/\D/g, '');

function rrnValid(d) {
  if (!/^\d{13}$/.test(d)) return false;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((a, x, i) => a + x * Number(d[i]), 0);
  const month = Number(d.slice(2, 4));
  const day = Number(d.slice(4, 6));
  return (11 - (sum % 11)) % 10 === Number(d[12]) && month >= 1 && month <= 12 && day >= 1 && day <= 31 && '12345678'.includes(d[6]);
}

function brnValid(d) {
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = w.reduce((a, x, i) => a + x * Number(d[i]), 0);
  sum += Math.floor((5 * Number(d[8])) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

function luhn(d) {
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) {
    let x = Number(d[d.length - 1 - i]);
    if (i % 2) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
    sum += x;
  }
  return sum % 10 === 0;
}

/**
 * 글자 속 개인정보로 보이는 것: [{ kind, value }]
 * 사업자등록번호는 법인도 있어 'brn'(경고용)으로 따로 둔다.
 */
export function findPII(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(/(?<!\d)\d{6}-?\d{7}(?!\d)/g)) if (rrnValid(digitsOf(m[0]))) out.push({ kind: '주민·외국인등록번호', value: m[0] });
  for (const m of s.matchAll(/(?<!\d)\d{3}-?\d{2}-?\d{5}(?!\d)/g)) if (brnValid(digitsOf(m[0]))) out.push({ kind: 'brn', value: m[0] });
  for (const m of s.matchAll(/(?<!\d)01[016789]-?\d{3,4}-?\d{4}(?!\d)/g)) out.push({ kind: '휴대전화', value: m[0] });
  for (const m of s.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/@(example\.(com|org)|users\.noreply\.github\.com)$/i.test(m[0])) out.push({ kind: '이메일', value: m[0] });
  for (const m of s.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) if (luhn(digitsOf(m[0]))) out.push({ kind: '카드번호', value: m[0].trim() });
  return out;
}

const mask = (v) => (String(v).length <= 4 ? '••••' : `${String(v).slice(0, 2)}••••${String(v).slice(-2)}`);

// ---------------------------------------------------------------- 정리

const META_DROP = ['recordedValue', 'suggestedFilename', 'fileNames', 'ts', 'rect', 'message'];

/**
 * 공유용으로 레시피를 정리한다.
 * @returns {{ recipe: object, removed: {where: string, what: string}[], remaining: {id: string, where: string, label: string, value: string}[] }}
 *   remaining: 자동으로 지우지 않은 값(변수로 바꾸지 않은 입력값 등). 사용자가 하나씩 확인한다.
 */
export function scrubRecipe(src) {
  const recipe = structuredClone(src ?? {});
  const removed = [];
  const remaining = [];
  for (const k of ['id', 'createdAt', 'updatedAt', 'origin']) {
    if (recipe[k] !== undefined) {
      removed.push({ where: '레시피', what: k });
      delete recipe[k];
    }
  }
  const visitTarget = (t) => {
    if (t?.meta?.rect !== undefined) delete t.meta.rect;
    for (const f of t?.framePath ?? []) if (typeof f?.url === 'string') f.url = stripQuery(f.url);
  };
  for (const s of stepsOf(recipe)) {
    const st = s.step;
    if (!st || typeof st !== 'object') continue;
    if (st.meta) {
      for (const k of META_DROP) {
        if (st.meta[k] === undefined) continue;
        if (k !== 'ts' && k !== 'rect') removed.push({ where: where(s), what: k === 'message' ? '알림창 문구' : k });
        delete st.meta[k];
      }
      if (typeof st.meta.url === 'string' && st.meta.url !== stripQuery(st.meta.url)) {
        removed.push({ where: where(s), what: '녹화 당시 주소의 쿼리' });
        st.meta.url = stripQuery(st.meta.url);
      }
    }
    if (st.type === 'upload' && st.path) {
      removed.push({ where: where(s), what: '첨부 파일 경로' });
      st.path = '';
    }
    visitTarget(st.target);
    if (st.condition) visitCondition(st.condition, visitTarget);
    // 변수로 바꾸지 않은 입력값·선택값·입력창 글자는 사람이 확인한다
    if ((st.type === 'input' || st.type === 'select') && typeof st.value === 'string' && st.value.trim() && !hasVar(st.value)) {
      remaining.push({ id: `${s.block}:${s.index}:value`, where: where(s), label: st.type === 'input' ? '입력값' : '선택값', value: st.value });
    }
    if (st.type === 'dialog' && typeof st.promptText === 'string' && st.promptText.trim() && !hasVar(st.promptText)) {
      remaining.push({ id: `${s.block}:${s.index}:promptText`, where: where(s), label: '입력창에 넣을 글자', value: st.promptText });
    }
    const pii = findPII(JSON.stringify(st.target ?? {}));
    if (pii.length) remaining.push({ id: `${s.block}:${s.index}:target`, where: where(s), label: `대상 요소에 ${pii[0].kind === 'brn' ? '사업자등록번호' : pii[0].kind}로 보이는 글자`, value: mask(pii[0].value) });
  }
  (recipe.variables ?? []).forEach((v, i) => {
    const src2 = v?.source ?? {};
    if (src2.kind === 'static' && String(src2.value ?? '').trim() && !hasVar(String(src2.value))) remaining.push({ id: `var:${i}:value`, where: `변수 {{${v.name ?? v.id}}}`, label: '고정값', value: String(src2.value) });
    if (src2.kind === 'prompt' && String(src2.default ?? '').trim()) remaining.push({ id: `var:${i}:default`, where: `변수 {{${v.name ?? v.id}}}`, label: src2.secret ? '비밀값 기본값' : '입력 기본값', value: src2.secret ? '••••' : String(src2.default) });
  });
  return { recipe, removed, remaining };
}

function visitCondition(c, visitTarget) {
  if (!c || typeof c !== 'object') return;
  if (c.target) visitTarget(c.target);
  if (c.condition) visitCondition(c.condition, visitTarget);
  for (const x of c.conditions ?? []) visitCondition(x, visitTarget);
}

export function stripQuery(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.includes('{{')) return url;
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** 남은 값 처리: decisions[id] === 'clear' 면 비운다 (keep 은 그대로) */
export function applyDecisions(recipe, decisions = {}) {
  const r = structuredClone(recipe);
  for (const [id, d] of Object.entries(decisions)) {
    if (d !== 'clear') continue;
    const [a, b, field] = id.split(':');
    if (a === 'var') {
      const v = r.variables?.[Number(b)];
      if (v?.source) delete v.source[field];
      continue;
    }
    const st = r.blocks?.[a]?.[Number(b)];
    if (!st) continue;
    if (field === 'target') continue; // 대상 요소는 지울 수 없다 — 다시 녹화하거나 변수로 바꿔야 한다
    st[field] = '';
  }
  return r;
}

// ---------------------------------------------------------------- 버전

export const isSemver = (v) => /^\d+\.\d+\.\d+$/.test(String(v ?? ''));
export function cmpSemver(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
/** ">=0.2.0 <0.3.0" 같은 범위 (공백으로 나눈 조건을 모두 만족) */
export function satisfies(version, range) {
  if (!isSemver(version)) return false;
  return String(range ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
      if (!m) return false;
      const c = cmpSemver(version, m[2]);
      return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0, undefined: c === 0 }[m[1]];
    });
}
export function engineRangeFor(version) {
  const [maj, min] = String(version).split('.').map(Number);
  return maj === 0 ? `>=${version} <0.${min + 1}.0` : `>=${version} <${maj + 1}.0.0`;
}

// ---------------------------------------------------------------- manifest

/** 레시피로 manifest 초안을 만든다 (작성자가 채울 칸은 비워 둔다) */
export function manifestDraft(recipe, { engineVersion, author = {}, columns = [], prompts = [] } = {}) {
  const risks = detectRisks(recipe);
  const slug = String(recipe?.name ?? 'set')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: `${String(author.github ?? 'me').toLowerCase()}/${slug || 'set'}`,
    name: recipe?.name ?? '',
    version: '1.0.0',
    summary: '',
    author,
    license: DEFAULT_LICENSE,
    tags: [],
    engine: { webRpa: engineRangeFor(engineVersion ?? '0.0.0'), recipeSchema: RECIPE_SCHEMA },
    recipe: 'recipe.json',
    sites: collectOrigins(recipe).map((origin) => ({ origin, purpose: '', login: risks.some((r) => r.flag === 'login') ? 'required' : 'none' })),
    columns: columns.map((name) => ({ name, required: true, example: '', help: '', personal: false })),
    prompts: prompts.map((v) => ({ name: v.name ?? v.id, secret: !!v.source?.secret })),
    attachments: [...stepsOf(recipe)].filter((s) => s.step?.type === 'upload').map((s) => ({ where: where(s), help: '' })),
    outputs: { values: [...new Set([...stepsOf(recipe)].filter((s) => s.step?.type === 'extract').map((s) => s.step.saveAs))] },
    risk: riskFlags(risks),
    pacing: { ...DEFAULT_PACING },
  };
}

/** manifest 형식 검사 → 문제 문장 배열 */
export function manifestProblems(m) {
  const p = [];
  if (!m || typeof m !== 'object') return ['manifest.json 이 JSON 객체가 아닙니다.'];
  if (m.format !== FORMAT) p.push(`format 은 "${FORMAT}" 이어야 합니다.`);
  if (m.formatVersion !== FORMAT_VERSION) p.push(`formatVersion ${m.formatVersion} 은(는) 지원하지 않습니다 (지원: ${FORMAT_VERSION}).`);
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(String(m.id ?? ''))) p.push('id 는 "게시자/이름" 형식(소문자·숫자·하이픈)이어야 합니다.');
  if (!String(m.name ?? '').trim()) p.push('name(이름)이 비었습니다.');
  if (!isSemver(m.version)) p.push('version 은 1.0.0 같은 세 자리 버전이어야 합니다.');
  if (String(m.summary ?? '').trim().length < 10) p.push('summary(무엇을 하는지)를 10자 이상 적어 주세요.');
  if (!String(m.license ?? '').trim()) p.push('license 가 비었습니다 (예: CC0-1.0).');
  if (!m.author?.name) p.push('author.name 이 비었습니다.');
  if (!m.engine?.webRpa || !/^(>=|<=|>|<|=)?\d+\.\d+\.\d+( (>=|<=|>|<|=)?\d+\.\d+\.\d+)*$/.test(String(m.engine.webRpa))) p.push('engine.webRpa 는 ">=0.2.0 <0.3.0" 같은 범위여야 합니다.');
  if (m.engine?.recipeSchema !== RECIPE_SCHEMA) p.push(`engine.recipeSchema 는 ${RECIPE_SCHEMA} 이어야 합니다.`);
  if (m.recipe !== 'recipe.json') p.push('recipe 는 "recipe.json" 이어야 합니다.');
  if (!Array.isArray(m.sites) || !m.sites.length) p.push('sites(접속 사이트)가 비었습니다.');
  for (const s of m.sites ?? []) {
    if (!/^https?:\/\/[^/]+$/.test(String(s?.origin ?? ''))) p.push(`sites 의 origin "${s?.origin}" 이(가) 올바르지 않습니다 (예: https://dart.fss.or.kr).`);
    if (!String(s?.purpose ?? '').trim()) p.push(`${s?.origin}: purpose(이 사이트에서 하는 일)를 적어 주세요.`);
  }
  if (!Array.isArray(m.columns)) p.push('columns 가 배열이 아닙니다.');
  if (!Array.isArray(m.risk)) p.push('risk 가 배열이 아닙니다.');
  const pc = m.pacing ?? {};
  if (!(Number(pc.minRowIntervalMs) >= 0) || !(Number(pc.maxRowsPerRun) >= 1)) p.push('pacing 에 minRowIntervalMs(0 이상)와 maxRowsPerRun(1 이상)이 있어야 합니다.');
  return p;
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text) {
  const t = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const filled = rows.filter((r) => r.some((c) => c !== ''));
  const [head = [], ...body] = filled;
  return { headers: head.map((h) => h.trim()), rows: body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? '']))) };
}

export function toCsv(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[headers.map(cell).join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- 세트 검사

/**
 * 세트 전체 검사 (허브 CI 와 가져오기 미리보기가 같이 쓴다).
 * @param {Map<string, Buffer>} files 세트 안 파일 (zip 에서 읽었거나 폴더에서 읽음)
 * @param {{ recipeProblems?: (r: object) => string[] }} [opts] 엔진의 레시피 검사기(있으면)
 * @returns {{ errors: string[], warnings: string[], manifest: object|null, recipe: object|null, computed: { origins: string[], risks: object[], flags: string[] } }}
 */
export function lintSet(files, { recipeProblems } = {}) {
  const errors = [];
  const warnings = [];
  let total = 0;
  for (const [name, data] of files) {
    total += data.length;
    if (!ALLOWED_FILES.some((re) => re.test(name))) errors.push(`세트에 넣을 수 없는 파일입니다: ${name} (허용: manifest.json, recipe.json, README.md, CHANGELOG.md, expected.json, input/sample.csv, input/template.xlsx, media/*.png·jpg)`);
    if (name.startsWith('media/') && data.length > MEDIA_MAX) errors.push(`${name}: 500KB 를 넘습니다 (영상은 링크로 넣어 주세요).`);
  }
  if (total > MAX_SET_BYTES) errors.push(`세트 크기가 2MB 를 넘습니다 (${(total / 1024 / 1024).toFixed(1)}MB).`);
  const json = (name) => {
    if (!files.has(name)) return undefined;
    try {
      return JSON.parse(files.get(name).toString('utf8'));
    } catch (e) {
      errors.push(`${name} 이(가) 올바른 JSON 이 아닙니다: ${e.message}`);
      return null;
    }
  };
  const manifest = json('manifest.json') ?? null;
  const recipe = json('recipe.json') ?? null;
  if (!files.has('manifest.json')) errors.push('manifest.json 이 없습니다.');
  if (!files.has('recipe.json')) errors.push('recipe.json 이 없습니다.');
  if (!files.has('README.md')) errors.push('README.md 가 없습니다.');
  if (!files.has('input/sample.csv')) errors.push('input/sample.csv(예시 입력)가 없습니다.');
  if (!files.has('expected.json')) warnings.push('expected.json(기대 결과)이 없습니다. 자동 확인을 할 수 없습니다.');
  if (manifest) errors.push(...manifestProblems(manifest));

  let origins = [];
  let risks = [];
  if (recipe) {
    if (recipe.schemaVersion !== undefined && recipe.schemaVersion !== RECIPE_SCHEMA) errors.push(`recipe.schemaVersion ${recipe.schemaVersion} 은(는) 지원하지 않습니다.`);
    if (recipeProblems) for (const pr of recipeProblems(recipe)) errors.push(`레시피: ${pr}`);
    for (const k of ['id', 'createdAt', 'updatedAt']) if (recipe[k] !== undefined) errors.push(`레시피에 ${k} 가 남아 있습니다 (내보내기에서 지워집니다).`);
    for (const s of stepsOf(recipe)) {
      const st = s.step ?? {};
      for (const k of META_DROP.filter((x) => x !== 'rect')) if (st.meta?.[k] !== undefined) errors.push(`${where(s)}: 녹화 정보 meta.${k} 가 남아 있습니다.`);
      if (typeof st.meta?.url === 'string' && st.meta.url !== stripQuery(st.meta.url)) errors.push(`${where(s)}: 녹화 당시 주소에 쿼리가 남아 있습니다.`);
      if (st.type === 'upload' && st.path) errors.push(`${where(s)}: 첨부 파일 경로가 남아 있습니다.`);
    }
    origins = collectOrigins(recipe);
    risks = detectRisks(recipe);
    if (manifest?.sites) {
      const declared = new Set(manifest.sites.map((x) => x?.origin));
      for (const o of origins) if (!declared.has(o)) errors.push(`레시피가 manifest 에 없는 사이트로 접속합니다: ${o}`);
      for (const d of declared) if (!origins.includes(d)) warnings.push(`manifest 에 적었지만 레시피가 쓰지 않는 사이트: ${d}`);
    }
    if (manifest?.risk) {
      const flags = riskFlags(risks);
      for (const f of flags) if (!manifest.risk.includes(f)) errors.push(`위험 표시 "${f}" 가 manifest.risk 에 없습니다 (${risks.find((r) => r.flag === f)?.detail}).`);
    }
    if (risks.some((r) => r.flag === 'submit') && ![...stepsOf(recipe)].some((s) => s.step?.type === 'pause')) warnings.push('되돌릴 수 없는 버튼을 누르는데 "사용자 확인 대기" 스텝이 없습니다. 앞에 확인 단계를 두거나 README 에 이유를 적어 주세요.');
  }

  // 개인정보: 레시피·예시·설명·기대 결과
  for (const name of ['recipe.json', 'input/sample.csv', 'README.md', 'expected.json', 'manifest.json', 'CHANGELOG.md']) {
    if (!files.has(name)) continue;
    for (const f of findPII(files.get(name).toString('utf8'))) {
      if (f.kind === 'brn') warnings.push(`${name}: 사업자등록번호로 보이는 값 ${mask(f.value)} — 개인사업자라면 개인정보입니다. 공개해도 되는 번호인지 확인해 주세요.`);
      else errors.push(`${name}: ${f.kind}로 보이는 값 ${mask(f.value)} 가 있습니다. 공개 세트에는 넣을 수 없습니다.`);
    }
  }

  // 예시 입력
  if (files.has('input/sample.csv')) {
    const { headers, rows } = parseCsv(files.get('input/sample.csv').toString('utf8'));
    if (!rows.length) errors.push('input/sample.csv 에 예시 행이 없습니다.');
    if (rows.length > 5) warnings.push(`input/sample.csv 가 ${rows.length}행입니다. 예시는 1~5행이면 충분합니다.`);
    for (const c of manifest?.columns ?? []) if (c?.required && !headers.includes(c.name)) errors.push(`input/sample.csv 에 엑셀 열 "${c.name}" 이(가) 없습니다.`);
    for (const r of rows) for (const v of Object.values(r)) if (/^[=+@\t\r]/.test(v) || /^-(?![\d.,]+$)/.test(v)) errors.push(`input/sample.csv: 수식으로 읽힐 수 있는 값 "${v.slice(0, 20)}" 이(가) 있습니다.`);
  }

  // 엑셀 양식: 매크로·외부 연결 금지 (xlsx 는 zip 이라 이름만 본다)
  if (files.has('input/template.xlsx')) warnings.push('input/template.xlsx 는 CI 가 매크로·외부 연결 여부를 따로 확인합니다. 가능하면 빼고 엔진이 양식을 만들게 하세요.');

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], manifest, recipe, computed: { origins, risks, flags: riskFlags(risks) } };
}

/** xlsx(zip) 안에 매크로·외부 연결·내장 개체가 있는지 */
export function xlsxDangers(entries) {
  const bad = [];
  for (const name of entries.keys()) {
    if (/vbaProject\.bin$/i.test(name)) bad.push('매크로(vbaProject.bin)');
    if (/^xl\/externalLinks\//i.test(name)) bad.push('외부 링크');
    if (/connections\.xml$/i.test(name)) bad.push('외부 데이터 연결');
    if (/^xl\/embeddings\//i.test(name) || /oleObject/i.test(name)) bad.push('내장 개체');
  }
  return [...new Set(bad)];
}

// ---------------------------------------------------------------- 기대 결과

/**
 * 실행 리포트를 expected.json 과 비교한다.
 * @param {{ totals: object, rows: { input: object, status: string, values: object, files: string[] }[] }} report
 * @param {object} expected { totals?, rows: { "*": rule, "<첫 열 값>": rule } }
 * @param {string} keyColumn 행을 가리키는 열 (예시 CSV 의 첫 열)
 * @returns {string[]} 다른 점 (비어 있으면 통과)
 */
export function compareExpected(report, expected, keyColumn) {
  const diffs = [];
  for (const [k, v] of Object.entries(expected?.totals ?? {})) if (report?.totals?.[k] !== v) diffs.push(`totals.${k}: 기대 ${v}, 실제 ${report?.totals?.[k]}`);
  const rules = expected?.rows ?? {};
  for (const row of report?.rows ?? []) {
    const key = String(row.input?.[keyColumn] ?? '');
    const rule = { ...(rules['*'] ?? {}), ...(rules[key] ?? {}), values: { ...(rules['*']?.values ?? {}), ...(rules[key]?.values ?? {}) } };
    if (rules[key]?.values && rules[key].replaceValues) rule.values = rules[key].values;
    const label = `${row.rowNumber ?? '?'}행(${key})`;
    if (rule.status && row.status !== rule.status) diffs.push(`${label}: 결과 기대 ${rule.status}, 실제 ${row.status}${row.error ? ` — ${row.error}` : ''}`);
    for (const [name, check] of Object.entries(rule.values ?? {})) {
      const actual = row.values?.[name];
      if (check === null) continue;
      if (actual === undefined) {
        if (!check.optional) diffs.push(`${label}: 값 {{${name}}} 이(가) 없습니다.`);
        continue;
      }
      if (check.equals !== undefined && actual !== check.equals) diffs.push(`${label}: {{${name}}} 기대 "${check.equals}", 실제 "${actual}"`);
      if (check.contains !== undefined && !String(actual).includes(check.contains)) diffs.push(`${label}: {{${name}}} 에 "${check.contains}" 가 없습니다 (실제 "${actual}")`);
      if (check.regex !== undefined && !new RegExp(check.regex).test(String(actual))) diffs.push(`${label}: {{${name}}} "${actual}" 이(가) 모양 ${check.regex} 와 다릅니다.`);
    }
    for (const f of rule.files ?? []) {
      const re = new RegExp(`^${String(f.glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      const hit = (row.files ?? []).map((x) => x.split('/').pop()).find((x) => re.test(x));
      if (!hit) diffs.push(`${label}: 파일 ${f.glob} 이(가) 없습니다.`);
    }
  }
  return diffs;
}
