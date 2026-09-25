#!/usr/bin/env python3
"""Checks .github/workflows/release.yml without a runner (used by test/packaging.test.sh).

- the build leg's step list: nothing up to the OS-binary upload may tolerate a
  failure, everything after it (the Windows extras) must;
- a small simulation of GitHub's step semantics (`if:` with the implicit
  `success() &&`, `continue-on-error`, `steps.<id>.outcome`) for every single
  failing step: a broken strip / installer build must leave the leg green with
  the OS binary uploaded (the release job is `needs: build`), a broken OS
  binary must fail it, and the installer only builds with the strip;
- the release job's bash steps, run for real against fixture dist/ folders and
  a stub `gh`: every OS binary + pulse-* alias required, the Windows extras
  checked only when present, the strip pair all-or-nothing.

Usage: release-workflow.py <release.yml>. Prints PASS/FAIL lines, exits 1 on
any FAIL.
"""
import os
import re
import stat
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:  # the caller checks for PyYAML first; belt and braces
    print('SKIP: python3 has no PyYAML')
    sys.exit(0)

FAILS = 0


def check(ok, msg):
    global FAILS
    print(('PASS: ' if ok else 'FAIL: ') + msg)
    if not ok:
        FAILS += 1


wf_path = sys.argv[1]
with open(wf_path) as f:
    wf = yaml.safe_load(f)
check(isinstance(wf, dict) and 'build' in wf.get('jobs', {}) and 'release' in wf.get('jobs', {}),
      'release.yml parses (python3 yaml) with build + release jobs')
build = wf['jobs']['build']
release = wf['jobs']['release']
bsteps = build['steps']


def label(s):
    if s.get('name') or s.get('id'):
        return s.get('name') or s['id']
    up = (s.get('with') or {}).get('name') if is_upload(s) else None
    return str(s.get('uses', '?')) + (' ' + str(up) if up else '')


def is_upload(s, name=None):
    return str(s.get('uses', '')).startswith('actions/upload-artifact') and (
        name is None or str((s.get('with') or {}).get('name', '')) == name)


def coe(s):
    return s.get('continue-on-error') is True


# --- 1. structure ---------------------------------------------------------
os_upload = next((i for i, s in enumerate(bsteps) if is_upload(s, '${{ matrix.artifact }}')), None)
check(os_upload is not None, 'build uploads the OS binary + alias as artifact ${{ matrix.artifact }}')
if os_upload is None:
    sys.exit(1)
strict = [label(s) for s in bsteps[:os_upload + 1] if coe(s)]
check(not strict, 'no step up to the OS-binary upload tolerates a failure (%s)' % (strict or 'none'))
extras = bsteps[os_upload + 1:]
windows_only = all("matrix.os == 'windows-latest'" in str(s.get('if', '')) for s in extras)
check(bool(extras) and windows_only, 'every step after the OS-binary upload is a Windows extra')
lenient = [label(s) for s in extras if not coe(s)]
check(not lenient, 'every Windows extra is continue-on-error (not: %s)' % (lenient or 'none'))
needs = release.get('needs')
needs = [needs] if isinstance(needs, str) else (needs or [])
rif = str(release.get('if', ''))
check('build' in needs and not re.search(r'always\(\)|failure\(\)|cancelled\(\)', rif),
      'release job is `needs: build` with no status override (a failed OS build still blocks it)')

# --- 2. simulation of the build leg -----------------------------------------
TOK = re.compile(r"\s*(?:(\|\||&&|==|!=|!|\(|\))|('(?:[^']|'')*')|([A-Za-z_][\w\-]*(?:\.[\w\-]+)*)(\(\))?)")


def evaluate(expr, ctx, statusfns):
    expr = expr.strip()
    m = re.fullmatch(r'\$\{\{(.*)\}\}', expr, re.S)
    if m:
        expr = m.group(1).strip()
    if not re.search(r'\b(success|failure|always|cancelled)\(\)', expr):
        expr = 'success() && (%s)' % expr
    toks, pos = [], 0
    while pos < len(expr):
        if expr[pos:].strip() == '':
            break
        m = TOK.match(expr, pos)
        if not m:
            raise ValueError('cannot parse if: %r at %d' % (expr, pos))
        op, s, ident, call = m.groups()
        toks.append(('op', op) if op else ('str', s[1:-1].replace("''", "'")) if s
                    else ('call', ident) if call else ('id', ident))
        pos = m.end()
    i = 0

    def peek():
        return toks[i] if i < len(toks) else (None, None)

    def take():
        nonlocal i
        i += 1
        return toks[i - 1]

    def primary():
        k, v = take()
        if k == 'op' and v == '!':
            return not truthy(primary())
        if k == 'op' and v == '(':
            r = orx()
            take()
            return r
        if k == 'str':
            return v
        if k == 'call':
            return statusfns[v]()
        if k == 'id':
            if v in ('true', 'false'):
                return v == 'true'
            cur = ctx
            for part in v.split('.'):
                cur = cur.get(part, '') if isinstance(cur, dict) else ''
            return cur
        raise ValueError('bad token %r in %r' % (v, expr))

    def truthy(x):
        return bool(x)

    def cmp():
        left = primary()
        while peek() in (('op', '=='), ('op', '!=')):
            _, op = take()
            right = primary()
            eq = str(left).lower() == str(right).lower()
            left = eq if op == '==' else not eq
        return left

    def andx():
        left = cmp()
        while peek() == ('op', '&&'):
            take()
            right = cmp()
            left = truthy(left) and truthy(right)
        return left

    def orx():
        left = andx()
        while peek() == ('op', '||'):
            take()
            right = andx()
            left = truthy(left) or truthy(right)
        return left

    return truthy(orx())


def simulate(os_name, fail_idx=None):
    """Run the build leg's steps; step number fail_idx fails when it runs. Returns the leg's
    result, the indices of the steps that ran, and the artifacts uploaded."""
    steps_ctx, conclusions, ran, uploaded = {}, [], [], []
    for idx, s in enumerate(bsteps):
        failed_so_far = 'failure' in conclusions
        fns = {'success': lambda: not failed_so_far, 'failure': lambda: failed_so_far,
               'always': lambda: True, 'cancelled': lambda: False}
        cond = s.get('if')
        runs = evaluate(str(cond), {'matrix': {'os': os_name}, 'steps': steps_ctx, 'env': {}}, fns) \
            if cond is not None else not failed_so_far
        if not runs:
            outcome = conclusion = 'skipped'
        else:
            ran.append(idx)
            outcome = 'failure' if idx == fail_idx else 'success'
            conclusion = 'success' if (outcome == 'failure' and coe(s)) else outcome
            if outcome == 'success' and is_upload(s):
                uploaded.append(str(s['with']['name']))
        conclusions.append(conclusion)
        if s.get('id'):
            steps_ctx[s['id']] = {'outcome': outcome, 'conclusion': conclusion}
    return ('failure' if 'failure' in conclusions else 'success'), ran, uploaded


OS_ART = '${{ matrix.artifact }}'
strip_build = next((s for s in extras if 'dotnet publish' in str(s.get('run', ''))), None)
installer_build = next((s for s in extras if 'ISCC' in str(s.get('run', '')) or 'iscc' in str(s.get('run', ''))), None)
check(strip_build is not None and installer_build is not None, 'found the strip and installer build steps')

status, ran, up = simulate('windows-latest')
check(status == 'success' and up == [OS_ART, 'burnglass-strip.exe', 'BurnglassSetup.exe'],
      'windows leg, nothing fails: OS binary, strip and installer all uploaded (%s)' % up)
status, ran, up = simulate('ubuntu-latest')
check(status == 'success' and up == [OS_ART] and not any(i > os_upload for i in ran),
      'linux leg: only the OS binary, no Windows extra runs')

installer_idx = bsteps.index(installer_build) if installer_build is not None else -1
for i in range(os_upload + 1, len(bsteps)):
    s = bsteps[i]
    status, ran, up = simulate('windows-latest', i)
    check(status == 'success' and OS_ART in up,
          'windows leg stays green with the OS binary uploaded when "%s" fails' % label(s))
    if s is strip_build or i == os_upload + 1:
        check('burnglass-strip.exe' not in up and 'BurnglassSetup.exe' not in up and installer_idx not in ran,
              'no strip artifact and no installer build after "%s" fails' % label(s))
for i in range(os_upload + 1):
    s = bsteps[i]
    if s.get('run') or is_upload(s):
        status, _, _ = simulate('windows-latest', i)
        check(status == 'failure', 'windows leg FAILS when OS-binary step "%s" fails' % label(s))

# --- 3. the release job's scripts, for real ---------------------------------
rsteps = {label(s): s for s in release['steps']}
verify = rsteps.get('Verify legacy aliases')
digests = rsteps.get('Verify published digests')
publish = next((s for s in release['steps'] if 'action-gh-release' in str(s.get('uses', ''))), None)
check(verify is not None and digests is not None and publish is not None,
      'release job has the alias check, the publish and the digest check')

NAMES = ['BurnglassSetup.exe', 'burnglass.exe', 'burnglass-linux', 'burnglass-macos', 'burnglass-strip.exe',
         'pulse.exe', 'pulse-linux', 'pulse-macos', 'pulse-strip.exe']
files = str((publish.get('with') or {}).get('files', ''))
check(all('dist/' + n in files for n in NAMES), 'the publish step lists all nine assets')
check(str((publish.get('with') or {}).get('fail_on_unmatched_files', False)).lower() != 'true',
      'the publish step tolerates a best-effort asset that was not built')

BYTES = {'burnglass.exe': b'W', 'pulse.exe': b'W', 'burnglass-linux': b'L', 'pulse-linux': b'L',
         'burnglass-macos': b'M', 'pulse-macos': b'M', 'burnglass-strip.exe': b'S', 'pulse-strip.exe': b'S',
         'BurnglassSetup.exe': b'I'}


def run_step(step, env, cwd, gh_tsv=None):
    e = dict(os.environ, **env)
    if gh_tsv is not None:
        bindir = tempfile.mkdtemp(dir=cwd)
        tsv = os.path.join(bindir, 'assets.tsv')
        with open(tsv, 'w') as f:
            f.write(gh_tsv)
        gh = os.path.join(bindir, 'gh')
        with open(gh, 'w') as f:
            f.write('#!/usr/bin/env bash\ncat "%s"\n' % tsv)
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IEXEC)
        e['PATH'] = bindir + os.pathsep + e['PATH']
    r = subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step['run']],
                       cwd=cwd, env=e, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def alias_case(desc, present, expect_ok, overrides=None, env=None, after=None):
    root = tempfile.mkdtemp(prefix='bg-rel-')
    dist = os.path.join(root, 'dist')
    os.makedirs(dist)
    for n in present:
        with open(os.path.join(dist, n), 'wb') as f:
            f.write((overrides or {}).get(n, BYTES[n]))
    rc, out = run_step(verify, env or {'TAG': 'v2.0.0', 'PRERELEASE': 'false'}, root)
    ok = (rc == 0) == expect_ok
    if ok and after:
        ok = after(set(os.listdir(dist)))
    check(ok, 'alias check: %s -> %s (rc=%d)%s' % (desc, 'passes' if expect_ok else 'fails', rc,
                                                  '' if ok else '\n' + out))


ALL = list(BYTES)
OS_ONLY = ['burnglass.exe', 'pulse.exe', 'burnglass-linux', 'pulse-linux', 'burnglass-macos', 'pulse-macos']
alias_case('all nine assets', ALL, True)
alias_case('OS binaries + aliases only (strip and installer not built)', OS_ONLY, True)
alias_case('strip built, installer not', OS_ONLY + ['burnglass-strip.exe', 'pulse-strip.exe'], True)
alias_case('pulse-linux missing', [n for n in ALL if n != 'pulse-linux'], False)
alias_case('burnglass-macos missing', [n for n in ALL if n != 'burnglass-macos'], False)
alias_case('pulse.exe missing, no Windows extras', [n for n in OS_ONLY if n != 'pulse.exe'], False)
alias_case('pulse-macos has different bytes', ALL, False, {'pulse-macos': b'X'})
alias_case('strip pair has different bytes', ALL, False, {'pulse-strip.exe': b'X'})
alias_case('lone burnglass-strip.exe is dropped, not published without its twin',
           OS_ONLY + ['burnglass-strip.exe'], True,
           after=lambda left: 'burnglass-strip.exe' not in left and set(OS_ONLY) <= left)
alias_case('lone pulse-strip.exe is dropped', OS_ONLY + ['pulse-strip.exe'], True,
           after=lambda left: 'pulse-strip.exe' not in left)
alias_case('rc tag not published as a prerelease', ALL, False, env={'TAG': 'v2.0.0-rc.1', 'PRERELEASE': 'false'})
alias_case('rc tag as a prerelease', ALL, True, env={'TAG': 'v2.0.0-rc.1', 'PRERELEASE': 'true'})

DIG = {'burnglass.exe': 'sha256:a', 'pulse.exe': 'sha256:a', 'burnglass-linux': 'sha256:b',
       'pulse-linux': 'sha256:b', 'burnglass-macos': 'sha256:c', 'pulse-macos': 'sha256:c',
       'burnglass-strip.exe': 'sha256:d', 'pulse-strip.exe': 'sha256:d', 'BurnglassSetup.exe': 'sha256:e'}


def digest_case(desc, names, expect_ok, overrides=None):
    root = tempfile.mkdtemp(prefix='bg-dig-')
    tsv = ''.join('%s\t%s\n' % (n, (overrides or {}).get(n, DIG[n])) for n in names)
    rc, out = run_step(digests, {'TAG': 'v2.0.0', 'GITHUB_REPOSITORY': 'o/r'}, root, gh_tsv=tsv)
    ok = (rc == 0) == expect_ok
    check(ok, 'published digests: %s -> %s (rc=%d)%s' % (desc, 'passes' if expect_ok else 'fails', rc,
                                                         '' if ok else '\n' + out))


digest_case('all nine, matching', ALL, True)
digest_case('no strip and no installer published', OS_ONLY, True)
digest_case('pulse-linux not published', [n for n in ALL if n != 'pulse-linux'], False)
digest_case('neither burnglass-macos nor pulse-macos published',
            [n for n in ALL if n not in ('burnglass-macos', 'pulse-macos')], False)
digest_case('burnglass-strip.exe published without pulse-strip.exe', OS_ONLY + ['burnglass-strip.exe'], False)
digest_case('pulse-macos digest differs', ALL, False, {'pulse-macos': 'sha256:z'})
digest_case('a digest not recorded yet (warning only)', ALL, True, {'pulse.exe': ''})

sys.exit(1 if FAILS else 0)
