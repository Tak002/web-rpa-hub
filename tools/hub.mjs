#!/usr/bin/env node
// web-rpa 공개 허브 도구. 의존성 없음 (Node 20 이상).
//
//   node tools/hub.mjs lint [세트폴더|파일.wrset ...] [--base <ref>] [--head <ref>] [--json <파일>]
//       세트 폴더 검사. 경로를 주지 않으면 --base 가 있을 때 바뀐 세트만, 없으면 모든 세트를 검사한다.
//       --base 가 있으면 "게시된 버전 폴더는 바꿀 수 없다", "새 버전은 기존보다 커야 한다" 도 검사한다.
//       --head 를 주면 작업 폴더 대신 그 git ref 의 내용을 데이터로 읽는다(파일을 풀지 않는다).
//   node tools/hub.mjs build --out dist
//       세트 폴더마다 .wrset 을 고정된 방식으로 묶고 sha256·크기를 계산해 dist/index.json, dist/index.html 을 만든다.
//   node tools/hub.mjs changed --base <ref> [--head <ref>] [--json]
//       PR 에서 바뀐 세트 폴더(sets/<게시자>/<이름>/<버전>) 목록.
//   node tools/hub.mjs unpack <파일.wrset> [--force]
//       .wrset 을 검사한 뒤 sets/<id>/<version>/ 에 푼다 (이슈로 받은 세트를 PR 로 옮길 때).
//   node tools/hub.mjs readme
//       README.md 의 세트 목록(<!-- sets:start --> ~ <!-- sets:end -->)을 다시 쓴다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintSet, xlsxDangers, cmpSemver, isSemver, stepsOf } from './wrset/core.mjs';
import { writeZip, readZip } from './wrset/zip.mjs';

export const HUB = {
  name: 'web-rpa 공개 허브',
  url: process.env.HUB_URL || 'https://tak002.github.io/web-rpa-hub/',
  repo: process.env.HUB_REPO || 'https://github.com/Tak002/web-rpa-hub',
};

export const SETS_DIR = 'sets';
const SEG = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SPDX_EXPR = /^[A-Za-z0-9][A-Za-z0-9.+-]*( (AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;
const COMMON_LICENSES = new Set(['CC0-1.0', 'MIT-0', 'MIT', '0BSD', 'Unlicense', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);

export const RISK_LABELS = {
  submit: '되돌릴 수 없는 버튼(제출·결제 등)',
  download: '파일 저장',
  upload: 'PC 파일 올리기',
  login: '로그인·사용자 확인 대기',
  'insecure-http': '암호화하지 않은 사이트(http)',
  'var-in-url': '엑셀 값을 주소에 넣음',
};

// ---------------------------------------------------------------- git

function git(root, args, { buffer = false } = {}) {
  const out = execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return buffer ? out : out.toString('utf8');
}

// ---------------------------------------------------------------- 세트를 읽는 출처 (작업 폴더 / git ref)

/** 작업 폴더에서 sets/ 아래 파일을 읽는다 */
export function fsSource(root) {
  const entries = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${ent.name}`;
      const a = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) entries.push({ path: r, kind: 'symlink' });
      else if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) entries.push({ path: r, kind: 'file' });
      else entries.push({ path: r, kind: 'other' });
    }
  };
  const base = path.join(root, SETS_DIR);
  if (fs.existsSync(base)) walk(base, SETS_DIR);
  return {
    label: '작업 폴더',
    entries: () => entries,
    read: (p) => fs.readFileSync(path.join(root, ...p.split('/'))),
  };
}

/** git ref 에서 sets/ 아래 파일을 데이터로 읽는다 (작업 폴더에 풀지 않는다 — PR 내용을 안전하게 읽을 때) */
export function gitSource(root, ref) {
  const raw = git(root, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', SETS_DIR]);
  const entries = [];
  const blobs = new Map();
  for (const line of raw.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    const p = line.slice(tab + 1);
    const kind = type === 'blob' && (mode === '100644' || mode === '100755') ? 'file' : mode === '120000' ? 'symlink' : 'other';
    entries.push({ path: p, kind });
    if (kind === 'file') blobs.set(p, sha);
  }
  return {
    label: ref,
    entries: () => entries,
    read: (p) => {
      if (!blobs.has(p)) throw new Error(`${ref} 에 ${p} 가 없습니다.`);
      return git(root, ['cat-file', 'blob', blobs.get(p)], { buffer: true });
    },
  };
}

/** "sets/p/n/v/…" → "sets/p/n/v" (세트 폴더 규칙에 맞지 않으면 null) */
export function folderOf(p) {
  const parts = String(p).split('/');
  if (parts[0] !== SETS_DIR || parts.length < 5) return null;
  return parts.slice(0, 4).join('/');
}

/** 출처 안의 세트 폴더 목록과 규칙 밖 경로 */
export function listFolders(src) {
  const folders = new Set();
  const stray = [];
  for (const e of src.entries()) {
    const f = folderOf(e.path);
    if (f) folders.add(f);
    else stray.push(e.path);
  }
  return { folders: [...folders].sort(), stray: stray.sort() };
}

/** 세트 폴더 하나 → { files: Map<상대경로, Buffer>, problems: string[] } */
export function readFolder(src, folder) {
  const files = new Map();
  const problems = [];
  const prefix = `${folder}/`;
  for (const e of src.entries()) {
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (e.kind === 'symlink') problems.push(`심볼릭 링크는 넣을 수 없습니다: ${rel}`);
    else if (e.kind !== 'file') problems.push(`일반 파일이 아닌 항목은 넣을 수 없습니다: ${rel}`);
    else files.set(rel, src.read(e.path));
  }
  return { files, problems };
}

/**
 * base 와 head 사이에 바뀐 세트 폴더.
 * head 가 없으면 작업 폴더(커밋 안 한 변경과 새 파일 포함)와 비교한다.
 */
export function changedSets(root, baseRef, headRef) {
  const mb = git(root, ['merge-base', baseRef, headRef || 'HEAD']).trim();
  const names = new Set();
  const diffArgs = headRef ? ['diff', '--name-only', '-z', '--no-renames', mb, headRef, '--', SETS_DIR] : ['diff', '--name-only', '-z', '--no-renames', mb, '--', SETS_DIR];
  for (const n of git(root, diffArgs).split('\0')) if (n) names.add(n);
  if (!headRef) for (const n of git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', SETS_DIR]).split('\0')) if (n) names.add(n);
  const folders = new Set();
  const stray = [];
  for (const n of [...names].sort()) {
    const f = folderOf(n);
    if (f) folders.add(f);
    else stray.push(n);
  }
  return { mergeBase: mb, paths: [...names].sort(), folders: [...folders].sort(), stray };
}

// ---------------------------------------------------------------- 검사

const uniq = (a) => [...new Set(a)];
const bumpPatch = (v) => (isSemver(v) ? v.replace(/\d+$/, (x) => String(Number(x) + 1)) : '1.0.1');
const columnNames = (m) => (Array.isArray(m?.columns) ? m.columns.map((c) => c?.name).filter(Boolean) : []);
const outputValues = (m) => (Array.isArray(m?.outputs?.values) ? m.outputs.values : []);

function sameFiles(a, b) {
  const diff = [];
  for (const [k, v] of a) if (!b.has(k)) diff.push(`${k}(삭제)`);
  else if (!v.equals(b.get(k))) diff.push(k);
  for (const k of b.keys()) if (!a.has(k)) diff.push(`${k}(추가)`);
  return diff.sort();
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 세트 파일 묶음(Map) 검사: core.lintSet + 허브 규칙(라이선스·expected·엑셀 양식·제출 정책).
 * 폴더와 상관없는 검사라 .wrset 파일에도 쓴다.
 */
export function lintFiles(files) {
  const res = lintSet(files);
  const errors = [...res.errors];
  let warnings = [...res.warnings];
  const notes = [];
  const m = res.manifest;
  if (m && typeof m === 'object') {
    const lic = String(m.license ?? '').trim();
    if (lic && !SPDX_EXPR.test(lic)) errors.push(`license "${lic}" 은(는) SPDX 식별자가 아닙니다 (예: CC0-1.0, MIT).`);
    else if (lic && !COMMON_LICENSES.has(lic)) warnings.push(`license "${lic}" 은(는) 허브에서 흔히 쓰는 라이선스가 아닙니다. 기본값은 CC0-1.0 입니다.`);
    if (m.author && m.author.github !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(m.author.github))) errors.push(`author.github "${m.author.github}" 이(가) GitHub 사용자 이름 형식이 아닙니다.`);
    if (!Array.isArray(m.tags)) warnings.push('tags(검색어 목록)가 없습니다.');
    const pc = m.pacing ?? {};
    if (Number(pc.minRowIntervalMs) < 1000) warnings.push(`pacing.minRowIntervalMs 가 ${pc.minRowIntervalMs}ms 입니다. 공개 사이트에는 1000ms 이상을 권합니다.`);
    if (!m.verified?.at) warnings.push('verified(마지막으로 예시 실행을 성공한 날짜와 결과)가 없습니다.');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.verified.at))) errors.push(`verified.at "${m.verified.at}" 은(는) YYYY-MM-DD 날짜여야 합니다.`);
    if (Array.isArray(m.risk)) {
      for (const f of m.risk) if (!RISK_LABELS[f]) errors.push(`알 수 없는 위험 표시 "${f}" (쓸 수 있는 값: ${Object.keys(RISK_LABELS).join(', ')}).`);
      for (const f of m.risk) if (RISK_LABELS[f] && res.recipe && !res.computed.flags.includes(f) && f !== 'login') warnings.push(`manifest.risk 에 "${f}" 를 적었지만 레시피에서는 찾지 못했습니다.`);
    }
    if (Array.isArray(m.sites)) for (const s of m.sites) if (s?.login !== undefined && !['none', 'required', 'optional'].includes(s.login)) errors.push(`${s.origin}: login 은 none, required, optional 중 하나여야 합니다.`);
    if (Array.isArray(m.columns)) for (const c of m.columns) if (c?.personal) warnings.push(`엑셀 열 "${c.name}" 이(가) 개인정보 열입니다. 예시 값은 반드시 합성값이어야 합니다.`);
  }

  if (files.has('expected.json')) {
    const ex = parseJson(files.get('expected.json'));
    if (ex === undefined) errors.push('expected.json 이 올바른 JSON 이 아닙니다.');
    else if (!ex || typeof ex !== 'object' || typeof ex.rows !== 'object' || ex.rows === null) errors.push('expected.json 에 rows(행별 기대 결과) 객체가 있어야 합니다.');
    else {
      for (const [key, rule] of Object.entries(ex.rows)) {
        for (const [name, check] of Object.entries(rule?.values ?? {})) {
          if (check?.regex !== undefined) {
            try {
              new RegExp(check.regex);
            } catch (e) {
              errors.push(`expected.json: rows["${key}"].values.${name} 의 정규식이 잘못됐습니다: ${e.message}`);
            }
          }
        }
      }
    }
  }

  if (files.has('input/template.xlsx')) {
    try {
      const bad = xlsxDangers(readZip(files.get('input/template.xlsx')));
      if (bad.length) errors.push(`input/template.xlsx 에 넣을 수 없는 내용이 있습니다: ${bad.join(', ')}`);
      else notes.push('input/template.xlsx: 매크로·외부 연결·내장 개체 없음');
    } catch (e) {
      errors.push(`input/template.xlsx 를 읽지 못했습니다: ${e.message}`);
    }
    warnings = warnings.filter((w) => !w.startsWith('input/template.xlsx 는 CI 가'));
  }

  // 정책 5: 되돌릴 수 없는 버튼은 사용자 확인 대기 또는 README 의 이유
  if (res.recipe && res.computed.flags.includes('submit') && ![...stepsOf(res.recipe)].some((s) => s.step?.type === 'pause')) {
    const readme = files.get('README.md')?.toString('utf8') ?? '';
    warnings = warnings.filter((w) => !w.startsWith('되돌릴 수 없는 버튼을 누르는데'));
    if (!/^#{2,3}\s*확인 대기를 두지 않은 이유/m.test(readme)) {
      const at = res.computed.risks.filter((r) => r.flag === 'submit').map((r) => r.where ?? r.detail).join(', ');
      errors.push(`되돌릴 수 없는 버튼(제출·결제 등)을 누르는데 "사용자 확인 대기"(pause) 스텝이 없습니다 (${at}). 그 스텝 앞에 확인 대기를 두거나 README 에 "## 확인 대기를 두지 않은 이유" 절을 써 주세요.`);
    }
  }

  return { errors: uniq(errors), warnings: uniq(warnings), notes, manifest: m && typeof m === 'object' ? m : null, recipe: res.recipe, computed: res.computed };
}

/** 이전 버전 manifest 와 비교한 안내(새 사이트·새 위험·열 변화) */
function compareWithPrevious(prev, m, version, prevVersion) {
  const notes = [];
  const warnings = [];
  const labels = [];
  if (!prev || !m) return { notes, warnings, labels };
  const prevSites = new Set((prev.sites ?? []).map((s) => s?.origin));
  const newSites = (m.sites ?? []).map((s) => s?.origin).filter((o) => o && !prevSites.has(o));
  if (newSites.length) {
    notes.push(`이전 버전 ${prevVersion} 에 없던 사이트: ${newSites.join(', ')}`);
    labels.push('사이트추가');
  }
  const prevRisk = new Set(prev.risk ?? []);
  const newRisk = (m.risk ?? []).filter((f) => !prevRisk.has(f));
  if (newRisk.length) {
    notes.push(`이전 버전 ${prevVersion} 에 없던 위험 표시: ${newRisk.join(', ')}`);
    labels.push('위험추가');
  }
  const pc = columnNames(prev);
  const nc = columnNames(m);
  const po = outputValues(prev);
  const no = outputValues(m);
  const breaking = pc.some((c) => !nc.includes(c)) || nc.some((c) => !pc.includes(c) && m.columns.find((x) => x.name === c)?.required) || po.some((o) => !no.includes(o));
  if (breaking && isSemver(version) && isSemver(prevVersion) && Number(version.split('.')[0]) <= Number(prevVersion.split('.')[0])) {
    warnings.push(`엑셀 열이나 출력 값 이름이 이전 버전 ${prevVersion} 과 달라졌습니다. 사용자의 기존 엑셀이 맞지 않으므로 major 버전을 올려 주세요 (예: ${Number(prevVersion.split('.')[0]) + 1}.0.0).`);
  }
  return { notes, warnings, labels };
}

/**
 * 세트 폴더 하나 검사.
 * @param {object} src 읽을 출처 (fsSource / gitSource)
 * @param {string} folder "sets/<게시자>/<이름>/<버전>"
 * @param {{ base?: object, baseFolders?: string[] }} [opts] base 를 주면 게시된 버전 보호·버전 증가를 검사한다
 */
export function lintFolder(src, folder, { base, baseFolders } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const labels = [];
  const [, p, n, v] = folder.split('/');
  if (!SEG.test(p ?? '')) errors.push(`게시자 폴더 이름 "${p}" 은(는) 소문자·숫자·하이픈만 쓸 수 있습니다.`);
  if (!SEG.test(n ?? '')) errors.push(`세트 폴더 이름 "${n}" 은(는) 소문자·숫자·하이픈만 쓸 수 있습니다.`);
  if (!SEMVER.test(v ?? '')) errors.push(`버전 폴더 "${v}" 은(는) 1.0.0 같은 세 자리 버전이어야 합니다.`);
  const { files, problems } = readFolder(src, folder);
  errors.push(...problems);
  if (!files.size && !problems.length) {
    errors.push('세트 폴더가 비었습니다.');
    return { folder, id: `${p}/${n}`, version: v, errors, warnings, notes, labels, manifest: null, computed: { origins: [], risks: [], flags: [] }, files };
  }
  const r = lintFiles(files);
  errors.push(...r.errors);
  warnings.push(...r.warnings);
  notes.push(...r.notes);
  const m = r.manifest;
  if (m) {
    if (m.id !== `${p}/${n}`) errors.push(`폴더 경로(sets/${p}/${n})와 manifest.id("${m.id}")가 다릅니다. 폴더는 sets/<manifest.id>/<version>/ 이어야 합니다.`);
    if (m.version !== v) errors.push(`폴더 버전(${v})과 manifest.version("${m.version}")이 다릅니다.`);
    if (m.author?.github && String(m.author.github).toLowerCase() !== p) warnings.push(`게시자 폴더 "${p}" 와 author.github "${m.author.github}" 가 다릅니다. 게시자 폴더는 보통 올린 사람의 GitHub 사용자 이름(소문자)입니다.`);
  }
  if (base) {
    const all = baseFolders ?? listFolders(base).folders;
    if (all.includes(folder)) {
      const diff = sameFiles(readFolder(base, folder).files, files);
      if (diff.length) errors.push(`이미 게시된 버전 ${v} 은(는) 바꿀 수 없습니다 (바뀐 파일: ${diff.join(', ')}). 고치려면 새 버전 폴더(예: sets/${p}/${n}/${bumpPatch(v)}/)를 만들어 주세요.`);
      else notes.push('이미 게시된 버전과 내용이 같습니다.');
    } else {
      const prevVersions = all.filter((f) => f.startsWith(`${SETS_DIR}/${p}/${n}/`)).map((f) => f.split('/')[3]).filter(isSemver).sort(cmpSemver);
      const max = prevVersions.at(-1);
      if (!max) notes.push('처음 올라오는 세트입니다.');
      else {
        if (isSemver(v) && cmpSemver(v, max) <= 0) errors.push(`새 버전 ${v} 은(는) 이미 게시된 최고 버전 ${max} 보다 커야 합니다.`);
        const prevFiles = readFolder(base, `${SETS_DIR}/${p}/${n}/${max}`).files;
        const prev = prevFiles.has('manifest.json') ? parseJson(prevFiles.get('manifest.json')) : null;
        const c = compareWithPrevious(prev, m, v, max);
        notes.push(`이전 최고 버전: ${max}`, ...c.notes);
        warnings.push(...c.warnings);
        labels.push(...c.labels);
      }
    }
  }
  return { folder, id: m?.id ?? `${p}/${n}`, version: m?.version ?? v, errors: uniq(errors), warnings: uniq(warnings), notes: uniq(notes), labels: uniq(labels), manifest: m, computed: r.computed, files };
}

/**
 * lint 명령의 본체 (ai-review 도 같이 쓴다).
 * @returns {{ results: object[], global: string[], mode: string }}
 */
export function runLint({ root, paths = [], baseRef, headRef }) {
  const head = headRef ? gitSource(root, headRef) : fsSource(root);
  const base = baseRef ? gitSource(root, baseRef) : null;
  const baseFolders = base ? listFolders(base).folders : undefined;
  const global = [];
  const results = [];
  let folders = [];
  let mode = 'all';
  const wrsetFiles = [];

  if (paths.length) {
    mode = 'paths';
    for (const p0 of paths) {
      if (/\.wrset$/i.test(p0)) {
        wrsetFiles.push(p0);
        continue;
      }
      const rel = path.relative(root, path.resolve(root, p0)).split(path.sep).join('/');
      const f = folderOf(`${rel}/x`) ?? folderOf(rel);
      if (!f) global.push(`세트 폴더 경로가 아닙니다: ${p0} (sets/<게시자>/<이름>/<버전> 이어야 합니다)`);
      else folders.push(f);
    }
    folders = uniq(folders).sort();
  } else if (baseRef) {
    mode = 'changed';
    const ch = changedSets(root, baseRef, headRef);
    folders = ch.folders;
    for (const s of ch.stray) global.push(`세트 폴더 규칙(sets/<게시자>/<이름>/<버전>/<파일>)에 맞지 않는 경로가 바뀌었습니다: ${s}`);
    if (folders.length > 1) global.push(`PR 하나에는 세트 버전 하나만 올려 주세요. 이 PR 에서 바뀐 세트 폴더: ${folders.join(', ')}`);
  } else {
    const l = listFolders(head);
    folders = l.folders;
    for (const s of l.stray) global.push(`세트 폴더 규칙(sets/<게시자>/<이름>/<버전>/<파일>)에 맞지 않는 파일: ${s}`);
  }

  const headFolders = new Set(listFolders(head).folders);
  for (const f of folders) {
    if (!headFolders.has(f)) {
      if (baseFolders?.includes(f)) results.push({ folder: f, id: f.split('/').slice(1, 3).join('/'), version: f.split('/')[3], errors: [`게시된 버전 폴더 ${f} 를 지웠습니다. 게시된 버전은 지울 수 없습니다 — 내려야 하면 삭제 요청 이슈를 열어 주세요(관리자가 처리).`], warnings: [], notes: [], labels: [], manifest: null, computed: { origins: [], risks: [], flags: [] }, files: new Map() });
      else global.push(`세트 폴더가 없습니다: ${f}`);
      continue;
    }
    results.push(lintFolder(head, f, { base, baseFolders }));
  }
  for (const w of wrsetFiles) {
    let files;
    try {
      files = readZip(fs.readFileSync(path.resolve(root, w)));
    } catch (e) {
      results.push({ folder: w, errors: [e.message], warnings: [], notes: [], labels: [], manifest: null, computed: { origins: [], risks: [], flags: [] }, files: new Map() });
      continue;
    }
    const r = lintFiles(files);
    results.push({ folder: w, id: r.manifest?.id, version: r.manifest?.version, ...r, labels: [], files });
  }
  return { results, global, mode };
}

// ---------------------------------------------------------------- 출력

const annEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const annProp = (s) => annEscape(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function printLint({ results, global, mode }) {
  const lines = [];
  const inActions = !!process.env.GITHUB_ACTIONS;
  if (!results.length && !global.length) lines.push(mode === 'changed' ? '바뀐 세트가 없습니다. 검사할 것이 없습니다.' : '검사할 세트가 없습니다.');
  for (const g of global) {
    lines.push(`오류: ${g}`);
    if (inActions) lines.push(`::error title=${annProp('세트 검사')}::${annEscape(g)}`);
  }
  for (const r of results) {
    lines.push('');
    lines.push(`■ ${r.folder}${r.manifest?.name ? ` — ${r.manifest.name}` : ''}`);
    lines.push(r.errors.length ? `  결과: 실패 (오류 ${r.errors.length}개, 경고 ${r.warnings.length}개)` : `  결과: 통과 (경고 ${r.warnings.length}개)`);
    for (const e of r.errors) lines.push(`  ✗ ${e}`);
    for (const w of r.warnings) lines.push(`  ! ${w}`);
    for (const n of r.notes) lines.push(`  · ${n}`);
    if (r.computed?.origins?.length) lines.push(`  · 접속 사이트(계산): ${r.computed.origins.join(', ')}`);
    if (r.computed) lines.push(`  · 위험 표시(계산): ${r.computed.flags.length ? r.computed.flags.join(', ') : '없음'}`);
    if (inActions) {
      const file = /\.wrset$/i.test(r.folder) ? r.folder : `${r.folder}/manifest.json`;
      for (const e of r.errors) lines.push(`::error file=${annProp(file)},title=${annProp('세트 검사')}::${annEscape(e)}`);
      for (const w of r.warnings) lines.push(`::warning file=${annProp(file)},title=${annProp('세트 검사')}::${annEscape(w)}`);
    }
  }
  const nErr = global.length + results.reduce((a, r) => a + r.errors.length, 0);
  const nWarn = results.reduce((a, r) => a + r.warnings.length, 0);
  lines.push('');
  lines.push(nErr ? `검사 실패: 오류 ${nErr}개, 경고 ${nWarn}개` : `검사 통과: 세트 ${results.length}개, 경고 ${nWarn}개`);
  process.stdout.write(`${lines.join('\n')}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### 세트 검사 ${nErr ? '실패' : '통과'}`, ''];
    for (const g of global) md.push(`- ✗ ${g}`);
    for (const r of results) {
      md.push(`#### \`${r.folder}\` ${r.errors.length ? '실패' : '통과'}`);
      for (const e of r.errors) md.push(`- ✗ ${e}`);
      for (const w of r.warnings) md.push(`- ! ${w}`);
      for (const n of r.notes) md.push(`- ${n}`);
      md.push('');
    }
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
    } catch {
      /* 요약은 없어도 된다 */
    }
  }
  return nErr;
}

export function lintToJson({ results, global, mode }) {
  return {
    ok: !global.length && results.every((r) => !r.errors.length),
    mode,
    global,
    sets: results.map((r) => ({ folder: r.folder, id: r.id ?? null, version: r.version ?? null, errors: r.errors, warnings: r.warnings, notes: r.notes, labels: r.labels ?? [], origins: r.computed?.origins ?? [], risk: r.computed?.flags ?? [], riskDetails: (r.computed?.risks ?? []).map((x) => ({ flag: x.flag, where: x.where ?? null, detail: x.detail })) })),
  };
}

// ---------------------------------------------------------------- build

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function firstCommitDate(root, folder) {
  try {
    const out = git(root, ['log', '--format=%cI', '--reverse', '--', folder]).trim();
    const first = out.split('\n')[0].trim();
    return first ? new Date(first).toISOString() : null;
  } catch {
    return null;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 세트 폴더들을 묶어 dist 를 만든다 */
export function build({ root, out, now = new Date() }) {
  const src = fsSource(root);
  const { folders, stray } = listFolders(src);
  const problems = stray.map((s) => `세트 폴더 규칙에 맞지 않는 파일: ${s}`);
  const results = folders.map((f) => lintFolder(src, f));
  for (const r of results) for (const e of r.errors) problems.push(`${r.folder}: ${e}`);
  if (problems.length) {
    const err = new Error(`세트 검사에 실패해 빌드하지 않았습니다:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    err.problems = problems;
    throw err;
  }
  const generatedAt = now.toISOString();
  const outAbs = path.resolve(out);
  if (outAbs === root || `${root}${path.sep}`.startsWith(`${outAbs}${path.sep}`) || fs.existsSync(path.join(outAbs, '.git')) || outAbs === path.join(root, SETS_DIR) || outAbs === path.join(root, 'tools')) throw new Error(`빌드 결과 폴더로 쓸 수 없는 위치입니다: ${out} (지우고 다시 만드는 폴더입니다)`);
  fs.rmSync(outAbs, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const byId = new Map();
  for (const r of results) {
    const m = r.manifest;
    const entries = [...r.files].map(([name, data]) => ({ name, data }));
    const buf = writeZip(entries);
    // 묶은 파일을 다시 읽어 내용이 같은지 확인
    const back = readZip(buf);
    if (back.size !== r.files.size || [...r.files].some(([k, v]) => !back.get(k)?.equals(v))) throw new Error(`${r.folder}: 묶은 .wrset 을 다시 읽은 내용이 다릅니다.`);
    const rel = `sets/${m.id}/${m.version}.wrset`;
    const dest = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    const docDir = path.join(out, 'sets', ...m.id.split('/'), m.version);
    fs.mkdirSync(docDir, { recursive: true });
    for (const [name, data] of r.files) {
      if (name === 'README.md' || name === 'CHANGELOG.md' || name.startsWith('media/')) {
        const d = path.join(docDir, ...name.split('/'));
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.writeFileSync(d, data);
      }
    }
    const version = {
      version: m.version,
      engine: m.engine?.webRpa ?? '',
      url: rel,
      sha256: sha256(buf),
      size: buf.length,
      publishedAt: firstCommitDate(root, r.folder) ?? generatedAt,
      risk: [...(m.risk ?? [])].sort(),
      sites: (m.sites ?? []).map((s) => s.origin),
      columns: columnNames(m),
      ...(m.verified?.at ? { verified: { at: m.verified.at, result: m.verified.result ?? '' } } : {}),
    };
    if (!byId.has(m.id)) byId.set(m.id, []);
    byId.get(m.id).push({ manifest: m, version });
  }

  const sets = [...byId.keys()].sort().map((id) => {
    const list = byId.get(id).sort((a, b) => cmpSemver(b.version.version, a.version.version));
    const latest = list[0].manifest;
    return {
      id,
      name: latest.name,
      summary: latest.summary,
      author: { name: latest.author?.name ?? '', ...(latest.author?.github ? { github: latest.author.github } : {}) },
      license: latest.license,
      tags: latest.tags ?? [],
      latest: latest.version,
      versions: list.map((x) => x.version),
      readme: `sets/${id}/${latest.version}/README.md`,
    };
  });

  const index = { format: 'web-rpa-hub-index', formatVersion: 1, generatedAt, hub: { ...HUB }, sets };
  fs.writeFileSync(path.join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'index.html'), renderIndexHtml(index));
  return index;
}

function renderIndexHtml(index) {
  const repo = index.hub.repo;
  const cards = index.sets
    .map((s) => {
      const v = s.versions[0];
      const risk = v.risk.length ? v.risk.map((f) => `<span class="tag risk">${esc(RISK_LABELS[f] ?? f)}</span>`).join(' ') : '<span class="muted">없음</span>';
      const older = s.versions.slice(1);
      return `<article class="card" id="${esc(s.id)}">
  <h2>${esc(s.name)}</h2>
  <p class="id"><code>${esc(s.id)}</code> · 최신 ${esc(s.latest)} · ${esc(s.license)} · 만든 사람 ${esc(s.author.github ? `@${s.author.github}` : s.author.name)}</p>
  <p>${esc(s.summary)}</p>
  <dl>
    <dt>접속 사이트</dt><dd>${v.sites.map((o) => `<code>${esc(o)}</code>`).join(' ')}</dd>
    <dt>엑셀 열</dt><dd>${v.columns.map((c) => `<code>${esc(c)}</code>`).join(' ') || '<span class="muted">없음</span>'}</dd>
    <dt>위험 표시</dt><dd>${risk}</dd>
    <dt>엔진</dt><dd>web-rpa <code>${esc(v.engine)}</code></dd>
    <dt>마지막 확인</dt><dd>${v.verified ? `${esc(v.verified.at)} (${esc(v.verified.result)})` : '<span class="muted">기록 없음</span>'}</dd>
    <dt>태그</dt><dd>${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</dd>
  </dl>
  <p class="actions"><a class="btn" href="${esc(v.url)}" download>세트 파일 받기 (.wrset, ${(v.size / 1024).toFixed(1)}KB)</a>
  <a href="${esc(`${repo}/tree/main/sets/${s.id}/${s.latest}`)}">설명(README) 보기</a></p>
  <p class="hash">sha256 <code>${esc(v.sha256)}</code></p>
  ${older.length ? `<details><summary>이전 버전 ${older.length}개</summary><ul>${older.map((o) => `<li><a href="${esc(o.url)}" download>${esc(o.version)}</a> · <code>${esc(o.sha256.slice(0, 16))}…</code></li>`).join('')}</ul></details>` : ''}
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>web-rpa 공개 허브</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #ffffff; --line: #e7e5e4; --accent: #1d4ed8; --risk: #b45309; --tagbg: #f5f5f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #161514; --fg: #f5f5f4; --muted: #a8a29e; --card: #1f1d1c; --line: #34302e; --accent: #93b4ff; --risk: #fbbf24; --tagbg: #2a2725; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
a { color: var(--accent); }
.lead, .muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 16px 0; }
.card h2 { font-size: 1.15rem; margin: 0 0 4px; }
.id { color: var(--muted); font-size: .9rem; margin: 0 0 8px; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: 7.5em 1fr; gap: 4px 12px; margin: 12px 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-size: .88em; }
.tag { display: inline-block; background: var(--tagbg); border-radius: 999px; padding: 0 8px; font-size: .85rem; }
.tag.risk { color: var(--risk); }
.btn { display: inline-block; background: var(--accent); color: var(--bg); text-decoration: none; padding: 6px 12px; border-radius: 6px; margin-right: 12px; }
.hash { font-size: .8rem; color: var(--muted); overflow-wrap: anywhere; }
footer { color: var(--muted); font-size: .9rem; border-top: 1px solid var(--line); margin-top: 32px; padding-top: 12px; }
@media (max-width: 520px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } }
</style>
</head>
<body>
<main>
<h1>web-rpa 공개 허브</h1>
<p class="lead">web-rpa 로 바로 쓸 수 있는 "진행 세트" 모음입니다. 세트에는 녹화한 작업 순서(레시피), 예시 입력, 설명이 들어 있습니다.</p>
<p><b>설치하는 방법</b>: web-rpa 0.2.0 이상의 <b>[허브]</b> 탭에서 고르면 바로 설치됩니다. 인터넷이 막힌 PC 라면 아래에서 <code>.wrset</code> 파일을 받아 옮긴 뒤 web-rpa 의 <b>[세트 파일 가져오기]</b>로 엽니다. 가져오기 화면에서 접속 사이트와 위험 표시를 꼭 확인하세요.</p>
<p class="muted">세트 ${index.sets.length}개 · 목록 갱신 ${esc(index.generatedAt.slice(0, 10))} · <a href="index.json">index.json</a></p>
${cards || '<p class="muted">아직 올라온 세트가 없습니다.</p>'}
<footer>
<p>세트를 올리려면 <a href="${esc(repo)}/blob/main/CONTRIBUTING.md">올리는 방법</a>, 지켜야 할 규칙은 <a href="${esc(repo)}/blob/main/POLICY.md">허브 정책</a>을 보세요. 고장 신고와 삭제 요청은 <a href="${esc(repo)}/issues/new/choose">이슈</a>로 받습니다.</p>
<p>자동화하려는 사이트의 이용약관과 자동 접속 정책을 지키는 것은 사용자의 책임입니다. 각 세트의 라이선스는 세트마다 다릅니다(기본 CC0-1.0).</p>
</footer>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------- unpack / readme

function unpack({ root, file, force }) {
  const files = readZip(fs.readFileSync(path.resolve(root, file)));
  const r = lintFiles(files);
  const m = r.manifest;
  if (!m || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(String(m.id ?? '')) || !isSemver(m.version)) throw new Error('manifest.json 의 id·version 을 읽지 못해 풀 위치를 정할 수 없습니다.');
  const dir = path.join(root, SETS_DIR, ...m.id.split('/'), m.version);
  if (fs.existsSync(dir) && !force) throw new Error(`${path.relative(root, dir)} 가 이미 있습니다 (덮어쓰려면 --force).`);
  const allowed = /^(manifest\.json|recipe\.json|README\.md|CHANGELOG\.md|expected\.json|input\/sample\.csv|input\/template\.xlsx|media\/[\w.-]+\.(png|jpe?g))$/i;
  const written = [];
  for (const [name, data] of files) {
    if (!allowed.test(name)) continue;
    const d = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, data);
    written.push(name);
  }
  return { dir: path.relative(root, dir).split(path.sep).join('/'), written, lint: r };
}

function updateReadme(root) {
  const src = fsSource(root);
  const { folders } = listFolders(src);
  const latest = new Map();
  for (const f of folders) {
    const { files } = readFolder(src, f);
    const m = files.has('manifest.json') ? parseJson(files.get('manifest.json')) : null;
    if (!m?.id || !isSemver(m.version)) continue;
    if (!latest.has(m.id) || cmpSemver(m.version, latest.get(m.id).version) > 0) latest.set(m.id, m);
  }
  const rows = [...latest.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((m) => `| [${m.name}](sets/${m.id}/${m.version}/README.md) | \`${m.id}\` | ${m.version} | ${(m.sites ?? []).map((s) => s.origin.replace(/^https?:\/\//, '')).join(', ')} | ${columnNames(m).join(', ')} | ${(m.risk ?? []).join(', ') || '없음'} |`);
  const table = ['| 세트 | id | 최신 | 사이트 | 엑셀 열 | 위험 표시 |', '|---|---|---|---|---|---|', ...rows].join('\n');
  const file = path.join(root, 'README.md');
  const text = fs.readFileSync(file, 'utf8');
  const re = /(<!-- sets:start -->)[\s\S]*?(<!-- sets:end -->)/;
  if (!re.test(text)) throw new Error('README.md 에 <!-- sets:start --> / <!-- sets:end --> 표시가 없습니다.');
  const next = text.replace(re, `$1\n${table}\n$2`);
  if (next !== text) fs.writeFileSync(file, next);
  return { changed: next !== text, count: rows.length };
}

// ---------------------------------------------------------------- CLI

const BOOL_FLAGS = new Set(['force', 'dry-run', 'post']);

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1);
      if (v !== undefined) opts[k] = v;
      else if (!BOOL_FLAGS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[k] = argv[(i += 1)];
      else opts[k] = true;
    } else opts._.push(a);
  }
  return opts;
}

const USAGE = `사용법:
  node tools/hub.mjs lint [세트폴더|파일.wrset ...] [--base <ref>] [--head <ref>] [--json <파일>]
  node tools/hub.mjs build --out dist
  node tools/hub.mjs changed --base <ref> [--head <ref>] [--json]
  node tools/hub.mjs unpack <파일.wrset> [--force]
  node tools/hub.mjs readme`;

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const root = path.resolve(opts.root ?? process.cwd());
  if (cmd === 'lint') {
    const res = runLint({ root, paths: opts._, baseRef: typeof opts.base === 'string' ? opts.base : undefined, headRef: typeof opts.head === 'string' ? opts.head : undefined });
    const nErr = printLint(res);
    if (typeof opts.json === 'string') fs.writeFileSync(opts.json, `${JSON.stringify(lintToJson(res), null, 2)}\n`);
    return nErr ? 1 : 0;
  }
  if (cmd === 'build') {
    const out = path.resolve(root, typeof opts.out === 'string' ? opts.out : 'dist');
    try {
      const index = build({ root, out });
      for (const s of index.sets) for (const v of s.versions) process.stdout.write(`${s.id}@${v.version}  ${v.sha256}  ${v.size}B  ${v.url}\n`);
      process.stdout.write(`index.json: 세트 ${index.sets.length}개 → ${path.relative(root, out) || out}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (cmd === 'changed') {
    if (typeof opts.base !== 'string') {
      process.stderr.write('--base <ref> 가 필요합니다.\n');
      return 2;
    }
    const ch = changedSets(root, opts.base, typeof opts.head === 'string' ? opts.head : undefined);
    if (opts.json) process.stdout.write(`${JSON.stringify(ch, null, 2)}\n`);
    else for (const f of ch.folders) process.stdout.write(`${f}\n`);
    for (const s of ch.stray) process.stderr.write(`세트 폴더 규칙에 맞지 않는 경로: ${s}\n`);
    return 0;
  }
  if (cmd === 'unpack') {
    if (!opts._[0]) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    try {
      const r = unpack({ root, file: opts._[0], force: !!opts.force });
      process.stdout.write(`${r.dir} 에 풀었습니다: ${r.written.join(', ')}\n`);
      printLint({ results: [{ folder: r.dir, ...r.lint, labels: [] }], global: [], mode: 'paths' });
      return r.lint.errors.length ? 1 : 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (cmd === 'readme') {
    const r = updateReadme(root);
    process.stdout.write(r.changed ? `README.md 세트 목록을 갱신했습니다 (${r.count}개).\n` : `README.md 세트 목록이 이미 최신입니다 (${r.count}개).\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked) process.exitCode = main();
