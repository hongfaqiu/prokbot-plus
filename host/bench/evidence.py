"""Offline evidence contract. Results are operator observations, never generated traffic."""
from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import datetime
import hashlib
import re
from statistics import median

from guest import MODES, SCHEMA, require
from telemetry import capture, decode, digest, fields, key, series, summarize, uint

PHASES = ('build', 'cold', 'idle', 'chat', 'desktop', 'restart', 'soak', 'concurrent')
CHECKS = {
    'build': ('pinned-inputs', 'image-ready'), 'cold': ('client-ready',), 'idle': ('idle-healthy',),
    'chat': ('chat-reply', 'context-reply'), 'desktop': ('desktop-frame', 'desktop-input'),
    'restart': ('identity-restored', 'history-restored'), 'soak': ('chat-reply',), 'concurrent': ('chat-reply',),
}
CHAT = ('chat-reply', 'context-reply')
STABLE = ('idle', 'chat', 'desktop', 'soak', 'concurrent')
MAX_LOAD_GAP_MS = 60000
POLICY = {'minimumRoundsPerSide': 3, 'minimumSoakMs': 3600000, 'maximumSoakCompletionGapMs': MAX_LOAD_GAP_MS,
          'minimumIdleMs': 60000, 'concurrentMinAvailablePct': 10, 'concurrentMaxP95NonIdlePct': 90,
          'concurrentMinMeasuredIntervals': 3, 'concurrentMinMeasuredMs': 60000}
REVIEW_SCOPE = ('Consistency of submitted observations only; matching source bytes are not attestation or publication approval. '
                'Eligibility does not establish a hardware minimum or capacity without the measured swap configuration.')
PREREQ = ('workloadSha256', 'datasetSha256', 'limitsSha256', 'modelConfigSha256')
EVIDENCE_ERRORS = (OSError, ValueError, KeyError, TypeError, IndexError, OverflowError)


def windows(manifest):
    phases = manifest['phases']
    require(isinstance(phases, dict) and set(phases) <= set(PHASES), 'Unknown workload phase')
    previous = 0
    for name in PHASES:
        if name not in phases:
            continue
        p = phases[name]
        fields(p, 'startMs endMs'); begin = uint(p['startMs'], 1); end = uint(p['endMs'], begin + 1)
        require(begin >= previous, 'Overlapping or out-of-order phases'); previous = end
    return phases


def overlap_windows(actions):
    # Count distinct clients, not requests. Adjacent spans are merged only while concurrency stays >= 2.
    edges = sorted((at, client, delta) for a in actions for at, client, delta in
                   ((a['startMs'], a['client'], 1), (a['endMs'], a['client'], -1)))
    spans, active, last = [], Counter(), None
    for at, client, delta in edges:
        if last is not None and at > last and len(active) >= 2:
            if spans and spans[-1][1] == last:
                spans[-1][1] = at
            else:
                spans.append([last, at])
        active[client] += delta
        if active[client] == 0:
            del active[client]
        last = at
    return spans


def inspect_actions(path, manifest, phases, issues):
    buckets = {name: [] for name in phases}
    sha = hashlib.sha256(); ids = set()
    with path.open('rb') as src:
        for raw in src:
            sha.update(raw)
            require(len(raw) < 128 * 1024, 'Oversized action record')
            a = decode(raw)
            fields(a, 'runId source phase check id client startMs endMs ok evidenceSha256')
            require(a['runId'] == manifest['runId'] and a['phase'] in phases, 'Action not bound to this run/phase')
            require(a['source'] in ('real-client', 'build-log', 'fixture', 'probe', 'synthetic'), 'Unknown action source')
            expected_source = 'build-log' if a['phase'] == 'build' else 'real-client'
            if a['source'] != expected_source:
                issues.add('Actions are not real client/build evidence: ' + a['phase'])
            permitted = set(CHECKS[a['phase']])
            if a['phase'] == 'soak' and manifest['mode'] != 'host-only':
                permitted.update(CHECKS['desktop'])
            require(a['check'] in permitted, 'Check not applicable to phase or topology')
            require(key(a['id']) not in ids, 'Duplicate action ID'); ids.add(a['id']); key(a['client'])
            digest(a['evidenceSha256']); require(type(a['ok']) is bool, 'Outcome must be boolean')
            p = phases[a['phase']]
            uint(a['startMs'], p['startMs'], p['endMs']); uint(a['endMs'], a['startMs'] + 1, p['endMs'])
            if a['check'] in CHAT:
                require('upstreamMs' in a, 'Missing upstream timing; use null when not instrumented')
                if a['upstreamMs'] is not None:
                    uint(a['upstreamMs'], high=a['endMs'] - a['startMs'])
            if not a['ok']:
                issues.add('Failed operation: ' + a['phase'] + '/' + a['check'])
            buckets[a['phase']].append(a)
    require(sha.hexdigest() == digest(manifest['actionLogSha256']), 'Action log digest mismatch')
    report, plan = {}, {}
    timeline = {'readyEnds': [], 'recoveryStarts': [], 'concurrentOverlap': []}
    for name, actions in buckets.items():
        p = phases[name]; duration = p['endMs'] - p['startMs']
        good = sorted((a for a in actions if a['ok']), key=lambda a: a['endMs'])
        checks = Counter(a['check'] for a in good)
        missing = set(CHECKS[name]) - checks.keys()
        if missing:
            issues.add('Missing successful checks for ' + name + ': ' + ', '.join(sorted(missing)))
        by_client = {}
        for a in actions:
            by_client.setdefault(a['client'], Counter())[a['check']] += 1
        chat = [a for a in actions if a['check'] in CHAT]
        elapsed = [a['endMs'] - a['startMs'] for a in chat]
        timed = [(a['upstreamMs'], ms) for a, ms in zip(chat, elapsed) if a['upstreamMs'] is not None]
        item = {'durationMs': duration, 'attempts': len(actions), 'errors': len(actions) - len(good),
                'successfulChecks': dict(checks), 'clients': len(by_client), 'endToEndMs': series(elapsed),
                'upstreamMs': series([u for u, _ in timed]), 'nonUpstreamMs': series([ms - u for u, ms in timed]),
                'unattributedChatCount': len(chat) - len(timed)}
        # Match the distribution of attempted work, not client aliases, response latency or outcomes.
        client_plan = sorted((dict(c) for c in by_client.values()), key=lambda c: sorted(c.items()))
        plan[name] = {'attemptsByCheck': dict(Counter(a['check'] for a in actions)), 'clients': len(by_client),
                      'perClientAttemptsByCheck': client_plan}
        if name in ('idle', 'soak', 'concurrent'):
            plan[name]['windowMs'] = duration
        if name == 'build':
            for role in MODES[manifest['mode']]:
                if set(CHECKS[name]) - {a['check'] for a in good if a['client'] == role}:
                    issues.add('Missing pinned build/image receipts for guest: ' + role)
        if name == 'idle' and duration < POLICY['minimumIdleMs']:
            issues.add('Idle observation shorter than 60 seconds')
        if name == 'cold':
            ready = next((a for a in good if a['check'] == 'client-ready'), None)
            item['coldStartMs'] = ready['endMs'] - p['startMs'] if ready else None
            timeline['readyEnds'] = [a['endMs'] for a in good]
        if name == 'chat':
            first_reply = {}
            for a in good:
                if a['check'] == 'chat-reply':
                    first_reply.setdefault(a['client'], a['endMs'])
            ordered = any(a['check'] == 'context-reply' and first_reply.get(a['client'], p['endMs'] + 1) <= a['startMs'] for a in good)
            if len(by_client) != 1 or not ordered:
                issues.add('Missing sequential single-client context conversation')
        if name == 'restart':
            paired = {a['client'] for a in buckets.get('cold', []) if a['ok'] and a['check'] == 'client-ready'}
            chat_clients = {a['client'] for a in buckets.get('chat', []) if a['ok'] and a['check'] == 'context-reply'}
            if len(chat_clients) != 1 or not chat_clients <= paired or {a['client'] for a in good} != chat_clients:
                issues.add('Recovery checks must use the original paired chat client')
            timeline['recoveryStarts'] = [a['startMs'] for a in good]
        if name == 'soak':
            times = [p['startMs'], *(a['endMs'] for a in good if a['check'] == 'chat-reply'), p['endMs']]
            item['longestCompletionGapMs'] = max(y - x for x, y in zip(times, times[1:]))
            if duration < POLICY['minimumSoakMs'] or item['longestCompletionGapMs'] > MAX_LOAD_GAP_MS:
                issues.add('Soak shorter than one hour or no successful chat for over 60 seconds')
        if name == 'concurrent':
            timeline['concurrentOverlap'] = overlap_windows(good)
            if not timeline['concurrentOverlap']:
                issues.add('No overlapping successful chats from distinct clients')
        report[name] = item
    return report, plan, sha.hexdigest(), timeline


def running(row, required):
    return all(row['services'].get(n, {}).get('usage') is not None and row['services'][n]['state'] == 'running' and
               row['services'][n]['health'] not in ('starting', 'unhealthy') for n in required)


def overlap_headroom(rows, times, spans, interval_ms):
    cpu, ram, duration = [], [], 0
    for start, end in spans:
        covered = rows[bisect_left(times, start):bisect_left(times, end)]  # Half-open request lifetimes.
        ram.extend(r['guest']['availableBytes'] for r in covered)
        for left, right in zip(covered, covered[1:]):
            a, b = left['guest']['cpuTicks'], right['guest']['cpuTicks']
            total = sum(b) - sum(a)
            cpu.append(100 * (total - (b[1] - a[1])) / total)
            duration += min(interval_ms, right['monoMs'] - left['monoMs'])  # A delayed tick earns at most one period.
    return {'intervals': len(cpu), 'measuredMs': duration, 'minAvailableBytes': min(ram, default=None), 'nonIdlePct': series(cpu)}


def phases_on_guest(trace, phases, spans, issues):
    rows = trace['samples']; times = [r['atMs'] for r in rows]
    header = trace['header']; role = header['role']; names = MODES[header['mode']][role][1]
    report = {}
    for name, phase in phases.items():
        begin, end = phase['startMs'], phase['endMs']
        if times[0] > begin or times[-1] < end:
            issues.add(f'{role}: phase outside sampled window: {name}')
            continue
        a, b = bisect_right(times, begin) - 1, bisect_left(times, end)
        inside = rows[bisect_left(times, begin):bisect_right(times, end)]
        item = summarize(trace, rows[a:b + 1])
        item.update(inPhaseSamples=len(inside), boundaryBeforeMs=begin - times[a], boundaryAfterMs=times[b] - end)
        if name == 'build' and len(inside) < 2:
            issues.add(f'{role}: no complete measured build interval; shorten the sampling period')
        if name in STABLE and (not inside or not all(running(row, names) for row in inside)):
            issues.add(f'{role}: missing healthy service measurements during {name}')
        if name in STABLE and any(not s['cpuCores'] or not s['initProcessCpuCores'] or s['processRssSumPeakBytes'] is None
                                  for s in item['services'].values()):
            issues.add(f'{role}: incomplete scoped CPU/process measurements during {name}')
        if name == 'cold' and any(s['state'] in ('running', 'restarting') for s in rows[a]['services'].values()):
            issues.add(f'{role}: already running at cold-start boundary')
        if name in ('cold', 'restart') and not running(rows[b], names):
            issues.add(f'{role}: no healthy endpoint sample after {name}')
        if name == 'concurrent':
            observed = overlap_headroom(rows, times, spans, header['intervalMs']); item['overlapHeadroom'] = observed
            if (observed['intervals'] < POLICY['concurrentMinMeasuredIntervals'] or
                    observed['measuredMs'] < POLICY['concurrentMinMeasuredMs']):
                issues.add(f'{role}: insufficient telemetry inside concurrent overlap')
            elif (100 * observed['minAvailableBytes'] / item['guest']['ramBytes'] < POLICY['concurrentMinAvailablePct'] or
                  observed['nonIdlePct']['p95'] > POLICY['concurrentMaxP95NonIdlePct']):
                issues.add(f'{role}: concurrent workload lacks configured CPU/RAM headroom')
        report[name] = item
    return report


def lifecycle(trace, phases, timeline, issues):
    rows = trace['samples']; header = trace['header']; role = header['role']; names = MODES[header['mode']][role][1]
    records = [e for e in trace['events'] if rows[0]['atMs'] <= e['atMs'] <= rows[-1]['atMs']]
    def in_phase(event, name):
        p = phases.get(name)
        return p is not None and p['startMs'] <= event['atMs'] < p['endMs']
    result = {}
    for name in names:
        events = [e for e in records if e['service'] == name]
        counts = Counter(e['action'] for e in events)
        container_ids = {row['services'][name]['id'] for row in rows if name in row['services']}
        if len(container_ids) != 1 or {e['id'] for e in events} - container_ids:
            issues.add(f'{role}/{name}: lifecycle not bound to one observed service container')
        cold = [e for e in events if in_phase(e, 'cold')]
        restarts = [e for e in events if in_phase(e, 'restart')]
        planned = int(role == 'host' and name == 'host')
        if len(cold) != 1 or cold[0]['action'] != 'start':
            issues.add(f'{role}/{name}: no single clean observed cold start')
        elif any(end <= cold[0]['atMs'] for end in timeline['readyEnds']):
            issues.add(f'{role}/{name}: client-ready did not follow the required service start')
        start = [e for e in restarts if e['action'] == 'start']; die = [e for e in restarts if e['action'] == 'die']
        if (len(start) != planned or len(die) != planned or
                planned and start and die and (die[0]['atMs'] >= start[0]['atMs'] or start[0]['id'] != die[0]['id']) or
                sum(e['action'] == 'restart' for e in restarts) > planned or any(e['action'] == 'destroy' for e in restarts)):
            issues.add(f'{role}/{name}: restart events do not match planned Host restart')
        elif planned and any(begin <= start[0]['atMs'] for begin in timeline['recoveryStarts']):
            issues.add(f'{role}/{name}: recovery read did not begin after the observed Host restart')
        unexpected = sum(not in_phase(e, 'cold') and not in_phase(e, 'restart') for e in events)
        if unexpected or counts['oom']:
            issues.add(f'{role}/{name}: unexpected service lifecycle or OOM event')
        seen, generations, starts, auto, oom, kills, killed = {}, {}, set(), 0, 0, 0, False
        start_events = sorted((e for e in events if e['action'] == 'start'), key=lambda e: e['atMs'])
        event_times = [e['atMs'] for e in start_events]; bindings = {}; init_ticks = {}
        for index, row in enumerate(rows):
            s = row['services'].get(name)
            if s is None:
                continue
            generation = s['id'], s['started']
            if s['state'] == 'running':
                starts.add(generation)
                # Compare the actual Docker start time, not just the number of distinct generations.
                event_index = bisect_right(event_times, row['atMs']) - 1
                if event_index < 0:
                    issues.add(f'{role}/{name}: running generation has no preceding start event')
                else:
                    e = start_events[event_index]
                    if generation not in bindings:
                        try:
                            # Docker emits nanoseconds; Python 3.10 only parses 3 or 6 fractional digits.
                            iso = re.sub(r'\.(\d+)', lambda m: '.' + m[1][:6].ljust(6, '0'), s['started'])
                            began = datetime.fromisoformat(iso.replace('Z', '+00:00'))
                            bindings[generation] = round(began.timestamp() * 1000)
                        except (ValueError, OverflowError, OSError):
                            bindings[generation] = None
                    stamp = bindings[generation]
                    if stamp is None or e['id'] != s['id'] or abs(e['atMs'] - stamp) > 1000:
                        issues.add(f'{role}/{name}: sampled generation does not match its start event')
                if s['usage'] and init_ticks.setdefault(generation, s['usage']['initStartTicks']) != s['usage']['initStartTicks']:
                    issues.add(f'{role}/{name}: init process changed within a container generation')
            last_count = seen.get(s['id'], s['autoRestarts'] if index == 0 else 0)
            require(s['autoRestarts'] >= last_count or generation not in generations, 'Restart counter reset')
            auto += max(0, s['autoRestarts'] - last_count); seen[s['id']] = s['autoRestarts']
            killed |= s['oomKilled']
            u = s['usage']
            if u:
                prev = generations.get(generation, (u['oom'], u['oomKills']) if index == 0 else (0, 0))
                require(u['oom'] >= prev[0] and u['oomKills'] >= prev[1], 'Cgroup OOM counter reset')
                oom += u['oom'] - prev[0]; kills += u['oomKills'] - prev[1]; generations[generation] = (u['oom'], u['oomKills'])
        if len(starts) != counts['start']:
            issues.add(f'{role}/{name}: missing or uncorroborated container start event')
        if auto or oom or kills or killed:
            issues.add(f'{role}/{name}: automatic restart or OOM observed')
        result[name] = {'dockerEvents': {act: counts[act] for act in ('start', 'die', 'restart', 'oom', 'destroy')},
                        'restartStarts': max(0, counts['start'] - 1), 'plannedRestartStarts': planned,
                        'outOfWindowEvents': unexpected, 'observedGenerations': len(starts), 'automaticRestarts': auto, 'cgroupOom': oom,
                        'cgroupOomKills': kills, 'dockerOomKilledObserved': killed}
    return result


def inspect_run(directory, evidence_dir=None):
    manifest = decode((directory / 'run.json').read_bytes())
    fields(manifest, 'schema runId mode revision origin modelKind actionLogSha256 traceSha256 provisioned phases ' + ' '.join(PREREQ))
    run_id = key(manifest['runId']); mode = manifest['mode']
    require(uint(manifest['schema']) == SCHEMA and mode in MODES and
            re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', manifest['revision']), 'Invalid schema, mode or revision')
    for field in PREREQ:
        digest(manifest[field])
    require(manifest['origin'] in ('measured', 'synthetic', 'probe') and manifest['modelKind'] in
            ('external-api', 'local-inference', 'mock', 'none'), 'Unknown provenance/model kind')
    issues = set(); phases = windows(manifest)
    required = set(PHASES) - {'build', 'concurrent'}
    if mode == 'host-only':
        required.remove('desktop')
        require('desktop' not in phases, 'Host-only cannot claim desktop coverage')
        issues.add('Host-only diagnostics: the execution desktop was not measured; no deployment capacity claim')
    for name in required - phases.keys():
        issues.add('Missing workload phase: ' + name)
    if manifest['origin'] != 'measured' or manifest['modelKind'] != 'external-api':
        issues.add('Not a measured external-API deployment; no capacity claim')
    actions, plan, action_sha, timeline = inspect_actions(directory / 'actions.jsonl', manifest, phases, issues)
    verified_sources = None
    if evidence_dir is not None:
        # Review an explicit, content-addressed export only; never follow operator paths embedded in receipts.
        with (directory / 'actions.jsonl').open('rb') as src:
            wanted = {decode(raw)['evidenceSha256'] for raw in src}
        verified_sources = 0
        for sha in wanted:
            path = evidence_dir / digest(sha)
            if path.is_symlink() or not path.is_file():
                issues.add('Missing review artifact: ' + sha)
                continue
            hash_ = hashlib.sha256()
            with path.open('rb') as src:
                for chunk in iter(lambda: src.read(1024 * 1024), b''):
                    hash_.update(chunk)
            if hash_.hexdigest() != sha:
                issues.add('Review artifact digest mismatch: ' + sha)
            else:
                verified_sources += 1
    roles = set(MODES[mode]); declared = manifest['traceSha256']
    require(isinstance(declared, dict) and set(declared) == roles, 'Wrong guest role set; split requires both machines')
    require(isinstance(manifest['provisioned'], dict) and set(manifest['provisioned']) == roles, 'Missing VM allocation per role')
    require({p.name for p in directory.glob('*.jsonl')} == {'actions.jsonl', *(role + '.jsonl' for role in roles)},
            'Missing/extra capture or action log in round directory')
    machines, identity, intervals, shas = {}, {}, {}, {'actions': action_sha}
    for role in sorted(roles):
        trace = capture(directory / (role + '.jsonl'), run_id, mode, role); header = trace['header']
        require(trace['sha256'] == digest(declared[role]), 'Guest capture digest mismatch: ' + role)
        shas[role] = trace['sha256']; rows = trace['samples']; g = rows[0]['guest']
        assigned = manifest['provisioned'][role]
        fields(assigned, 'vcpus ramBytes'); uint(assigned['vcpus'], 1); uint(assigned['ramBytes'], 1)
        require(assigned['vcpus'] == g['vcpus'] and 0.8 * assigned['ramBytes'] <= g['ramBytes'] <= assigned['ramBytes'],
                'Hypervisor allocation does not match whole guest; container limits are not VM capacity')
        intervals[role] = [rows[0]['atMs'], rows[-1]['atMs']]
        identity[role] = {'machine': header['machine'], 'provisioned': assigned, 'project': header['project'], 'intervalMs': header['intervalMs'],
                          'vcpus': g['vcpus'], 'ramBytes': g['ramBytes'], 'swapBytes': g['swapBytes'],
                          'diskBytes': {k: d[0] for k, d in g['disks'].items()}, 'cgroupLimits': trace['limits']}
        if header['origin'] != 'linux-whole-guest':
            issues.add('Synthetic guest capture: ' + role)
        whole = summarize(trace, rows)
        if whole['guest']['oomKills']:
            issues.add(f'{role}: whole-guest OOM kill observed')
        if not g['swapBytes'] and (whole['guest']['swapInBytes'] or whole['guest']['swapOutBytes']):
            issues.add(f'{role}: guest paging advanced with zero sampled swap capacity')
        machines[role] = {'boot': header['boot'], 'observation': whole,
                          'phases': phases_on_guest(trace, phases, timeline['concurrentOverlap'], issues),
                          'lifecycle': lifecycle(trace, phases, timeline, issues)}
    require(len({v['machine']['key'] for v in identity.values()}) == len(roles), 'Split roles must be distinct guests')
    return {'runId': run_id, 'mode': mode, 'revision': manifest['revision'], 'origin': manifest['origin'],
            'modelKind': manifest['modelKind'], 'controls': {k: manifest[k] for k in PREREQ}, 'machines': machines,
            'matchedEnvironment': identity, 'sampleWindowsMs': intervals, 'hashes': shas, 'plan': plan,
            'sourceArtifactsChecked': verified_sources, 'reviewScope': REVIEW_SCOPE,
            'actions': actions, 'issues': sorted(issues), 'eligibleRound': not issues}


def cohort(directory, evidence_dir=None):
    require(directory.is_dir(), 'Missing cohort directory')
    paths = sorted(directory.iterdir(), key=lambda path: path.name)
    require(paths and all(p.is_dir() for p in paths), 'A cohort must contain only numbered round directories')
    result, invalid = {}, {}
    for path in paths:
        require(re.fullmatch(r'[1-9]\d{0,3}', path.name), 'Use decimal round numbers without leading zeros')
        try:
            result[int(path.name)] = inspect_run(path, evidence_dir)
        except EVIDENCE_ERRORS as error:
            invalid[int(path.name)] = str(error)
    require((result.keys() | invalid.keys()) == set(range(1, len(paths) + 1)), 'Missing round number; do not drop partial/failed rounds')
    return result, invalid


def headline(run):
    values = {}
    for role, machine in run['machines'].items():
        for phase, observation in machine['phases'].items():
            prefix = role + '.' + phase + '.'
            g = observation['guest']
            for field in ('ramPeakBytes', 'ramPeakGrowthBytes', 'ramEndGrowthBytes', 'minAvailableBytes', 'swapUsedPeakBytes',
                          'swapInBytes', 'swapOutBytes', 'oomKills'):
                values[prefix + field] = g[field]
            for field in ('busyPct', 'ioWaitPct', 'stealPct', 'nonIdlePct'):
                if g['cpu'][field]:
                    values[prefix + field + 'P95'] = g['cpu'][field]['p95']
            if phase == 'concurrent' and observation['overlapHeadroom']['nonIdlePct']:
                h = observation['overlapHeadroom']
                values[prefix + 'overlap.minAvailableBytes'] = h['minAvailableBytes']
                values[prefix + 'overlap.nonIdlePctP95'] = h['nonIdlePct']['p95']
            if observation['serviceRamPeakBytes'] is not None:
                values[prefix + 'serviceRamPeakBytes'] = observation['serviceRamPeakBytes']
            for disk, d in g['disks'].items():
                for field in ('peakUsedBytes', 'peakGrowthBytes', 'endGrowthBytes', 'minFreeBytes'):
                    values[prefix + 'disk.' + disk + '.' + field] = d[field]
            for name, s in observation['services'].items():
                for field in ('cgroupRamPeakBytes', 'processRssSumPeakBytes', 'initProcessRssPeakBytes'):
                    if s[field] is not None:
                        values[prefix + name + '.' + field] = s[field]
                for field in ('cpuCores', 'initProcessCpuCores'):
                    if s[field]:
                        values[prefix + name + '.' + field + 'P95'] = s[field]['p95']
    for phase, a in run['actions'].items():
        values['client.' + phase + '.durationMs'] = a['durationMs']
        values['client.' + phase + '.errors'] = a['errors']
        if a.get('coldStartMs') is not None:
            values['client.cold.coldStartMs'] = a['coldStartMs']
        for field in ('endToEndMs', 'upstreamMs', 'nonUpstreamMs'):
            if a[field] and (field == 'endToEndMs' or not a['unattributedChatCount']):
                values['client.' + phase + '.' + field + 'P95'] = a[field]['p95']
    return values


def compare(before_dir, after_dir, evidence_dir=None):
    before, bad_before = cohort(before_dir, evidence_dir); after, bad_after = cohort(after_dir, evidence_dir)
    if bad_before or bad_after:
        numbers = sorted(before.keys() | bad_before.keys() | after.keys() | bad_after.keys())
        reasons = [f'{side}/{number}: {error}' for side, errors in (('before', bad_before), ('after', bad_after))
                   for number, error in errors.items()]
        return {'policy': POLICY, 'eligibleForReview': False, 'reviewScope': REVIEW_SCOPE, 'invalidEvidence': True, 'issues': reasons, 'deltas': {},
                'rounds': [{'number': n, 'before': before.get(n, {'invalid': bad_before.get(n, 'missing')}),
                            'after': after.get(n, {'invalid': bad_after.get(n, 'missing')})} for n in numbers]}
    require(before.keys() == after.keys(), 'Unpaired before/after rounds')
    rounds = sorted(before); base = before[rounds[0]]; after_base = after[rounds[0]]
    require(base['revision'] != after_base['revision'], 'Before and after must be distinct tested revisions')
    runs = [*(before[n] for n in rounds), *(after[n] for n in rounds)]
    require(len({r['runId'] for r in runs}) == len(runs), 'A run was reused')
    all_hashes = [h for r in runs for h in r['hashes'].values()]
    require(len(set(all_hashes)) == len(all_hashes), 'Reused capture or action log')
    for r in runs:
        for field in ('mode', 'modelKind', 'controls', 'matchedEnvironment', 'plan'):
            require(r[field] == base[field], 'Mismatched before/after control: ' + field)
    for role in base['machines']:
        intervals = [r['sampleWindowsMs'][role] for r in runs]
        require(all(a[1] < b[0] for a, b in zip(intervals, intervals[1:])), 'Overlapping/reordered guest captures: ' + role)
    def images(run):
        return {role: {name: s['imageSha256'] for name, s in m['observation']['services'].items()}
                for role, m in run['machines'].items()}
    for group, first in ((before, base), (after, after_base)):
        for r in group.values():
            require(r['revision'] == first['revision'] and images(r) == images(first), 'Revision or image drift within a cohort')
    reasons = [f"{r['runId']}: {reason}" for r in runs for reason in r['issues']]
    host_images = {images(r)['host']['host'] for r in (base, after_base)}
    if None in host_images or len(host_images) != 2:
        reasons.append('Host code comparison requires distinct observed Host images, not only distinct revision labels')
    if len(rounds) < POLICY['minimumRoundsPerSide']:
        reasons.append('Fewer than three independent paired rounds')
    deltas = {}
    if not reasons:
        a, b = [headline(before[n]) for n in rounds], [headline(after[n]) for n in rounds]
        for field in sorted(set.intersection(*(set(s) for s in a + b))):
            left, right = [s[field] for s in a], [s[field] for s in b]
            deltas[field] = {'beforeMedian': median(left), 'afterMedian': median(right),
                             'pairedDeltas': [round(y - x, 6) for x, y in zip(left, right)],
                             'medianPairedDelta': round(median(y - x for x, y in zip(left, right)), 6)}
    return {'policy': POLICY, 'mode': base['mode'], 'eligibleForReview': not reasons,
            'scope': 'Host only; no desktop' if base['mode'] == 'host-only' else 'Host and execution desktop',
            'buildObserved': not reasons and 'build' in base['plan'],
            'concurrencyAndHeadroomObserved': not reasons and 'concurrent' in base['plan'],
            'matchedEnvironment': base['matchedEnvironment'], 'controls': base['controls'], 'issues': reasons,
            'sourceArtifactsChecked': evidence_dir is not None, 'reviewScope': REVIEW_SCOPE,
            'rounds': [{'number': n, 'before': before[n], 'after': after[n]} for n in rounds], 'deltas': deltas}
