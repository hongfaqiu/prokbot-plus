"""Validate raw captures before deriving peaks, counter deltas and service metrics."""
import hashlib
import json
import math
import re

from guest import ACTIONS, HEX, ID, MODES, SCHEMA, VM_TYPES, require


def pairs(items):
    result = dict(items)
    require(len(items) == len(result), 'Duplicate JSON field')
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, 'Non-finite JSON number'))


def fields(obj, names):
    require(isinstance(obj, dict) and set(names.split()) <= obj.keys(), 'Missing required fields: ' + names)


def uint(value, low=0, high=2**63 - 1):
    require(type(value) is int and low <= value <= high, 'Invalid integer/counter')
    return value


def key(value):
    require(isinstance(value, str) and ID.fullmatch(value), 'Invalid public identifier')
    return value


def digest(value):
    require(isinstance(value, str) and HEX.fullmatch(value), 'Invalid SHA-256')
    return value


def check_guest(g, machine):
    fields(g, 'vcpus cpuTicks ramBytes availableBytes swapBytes swapUsedBytes oomKills swapInPages swapOutPages disks')
    uint(g['vcpus'], 1, 65536); uint(g['ramBytes'], 1); uint(g['availableBytes'], high=g['ramBytes'])
    uint(g['swapBytes']); uint(g['swapUsedBytes'], high=g['swapBytes'])
    for name in ('oomKills', 'swapInPages', 'swapOutPages'):
        uint(g[name])
    ticks = g['cpuTicks']
    require(isinstance(ticks, list) and len(ticks) == 4, 'Missing CPU ticks')
    for tick in ticks:
        uint(tick)
    require(isinstance(g['disks'], dict) and set(g['disks']) == set(machine['disks'].values()), 'Wrong disk set')
    for disk in g['disks'].values():
        require(isinstance(disk, list) and len(disk) == 3, 'Invalid filesystem observation')
        total, used, free = disk
        uint(total, 1); uint(used, high=total); uint(free, high=total - used)


def check_service(name, s, arch):
    fields(s, 'id image arch state health started autoRestarts oomKilled usage')
    digest(s['id']); digest(s['image']); uint(s['autoRestarts'])
    require(s['arch'] == (arch if name == 'host' else 'linux/amd64'), 'Service image architecture mismatch')
    require(s['state'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead') and
            s['health'] in ('none', 'starting', 'healthy', 'unhealthy') and type(s['oomKilled']) is bool and
            isinstance(s['started'], str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d\d:\d\d)', s['started']),
            'Invalid Docker service state')
    u = s['usage']
    if u is None:
        return
    require(s['state'] == 'running', 'Usage attributed to a non-running container')
    names = 'cpuUs ramBytes oom oomKills processCount rssMissed processRssBytes initStartTicks initTicks initRssBytes'
    fields(u, names + ' limits')
    for field in names.split():
        uint(u[field])
    uint(u['processCount'], 1); uint(u['rssMissed'], high=u['processCount'])
    limits = u['limits']
    fields(limits, 'cpuCores memoryBytes swapBytes cpuSet')
    for field in ('memoryBytes', 'swapBytes'):
        if limits[field] is not None:
            uint(limits[field])
    quota = limits['cpuCores']
    require(quota is None or type(quota) in (float, int) and math.isfinite(quota) and quota > 0, 'Invalid CPU quota')
    require(isinstance(limits['cpuSet'], str) and re.fullmatch(r'\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*', limits['cpuSet']),
            'Invalid effective cpuset')


def capture(path, run_id, mode, role):
    samples, events, sha = [], [], hashlib.sha256()
    header = end = None
    images, caps = {}, {}
    expected_arch, allowed = MODES[mode][role]
    with path.open('rb') as src:
        for raw in src:
            sha.update(raw)
            require(len(raw) < 1024 * 1024 and end is None, 'Oversized or trailing capture record')
            obj = decode(raw)
            fields(obj, 'type')
            kind = obj['type']
            if header is None:
                fields(obj, 'schema origin runId mode role project machine boot intervalMs durationMs')
                require(kind == 'header' and uint(obj['schema']) == SCHEMA and
                        (obj['runId'], obj['mode'], obj['role']) == (run_id, mode, role), 'Wrong capture header or run binding')
                require(obj['origin'] in ('linux-whole-guest', 'synthetic'), 'Unknown capture origin')
                key(obj['project']); digest(obj['boot']); uint(obj['intervalMs'], 1000, 30000)
                uint(obj['durationMs'], 2 * obj['intervalMs'], 86400000)
                machine = obj['machine']
                fields(machine, 'key arch virt os osVersion kernel dockerVersion pageBytes tickHz disks')
                digest(machine['key']); uint(machine['pageBytes'], 1); uint(machine['tickHz'], 1)
                require(machine['arch'] in ('linux/amd64', 'linux/arm64') and expected_arch in (None, machine['arch']),
                        'Wrong whole-guest architecture')
                for field in ('virt', 'os', 'osVersion', 'kernel', 'dockerVersion'):
                    require(isinstance(machine[field], str) and 0 < len(machine[field]) <= 128, 'Invalid system identity')
                require(machine['virt'] not in ('none', 'docker', 'wsl', 'lxc', 'podman'), 'Not a whole VM')
                if obj['origin'] == 'linux-whole-guest':
                    require(machine['virt'] in VM_TYPES and 'microsoft' not in machine['kernel'].lower(),
                            'Not a whole VM: unrecognized VM identifier or WSL kernel')
                fields(machine['disks'], 'root docker')
                for alias, target in machine['disks'].items():
                    key(alias); key(target)
                    require(machine['disks'].get(target) == target, 'Invalid disk alias')
                header = obj
            elif kind == 'sample':
                fields(obj, 'seq atMs monoMs guest services')
                require(uint(obj['seq']) == len(samples), 'Duplicate/missing sample sequence')
                uint(obj['atMs'], 1); uint(obj['monoMs'], 1)
                g = obj['guest']
                check_guest(g, machine)
                require(isinstance(obj['services'], dict) and set(obj['services']) <= set(allowed), 'Wrong project service set')
                for name, s in obj['services'].items():
                    check_service(name, s, machine['arch'])
                    require(images.setdefault(name, s['image']) == s['image'], 'Service image changed within round')
                    if s['usage'] is not None:
                        limit = s['usage']['limits']
                        require(caps.setdefault(name, limit) == limit, 'Cgroup limits changed within round')
                if samples:
                    prev = samples[-1]
                    dm, dw = obj['monoMs'] - prev['monoMs'], obj['atMs'] - prev['atMs']
                    require(0 < dm <= 2 * header['intervalMs'] + 1000 and dw > 0 and abs(dm - dw) <= 1000 and
                            abs(obj['atMs'] - samples[0]['atMs'] - obj['monoMs'] + samples[0]['monoMs']) <= 1000,
                            'Sampling gap or clock discontinuity')
                    old = prev['guest']
                    for name in ('ramBytes', 'vcpus', 'swapBytes'):
                        require(old[name] == g[name], 'Guest capacity changed during sampling')
                    for name in g['disks']:
                        require(old['disks'][name][0] == g['disks'][name][0], 'Disk capacity changed during sampling')
                    for name in ('oomKills', 'swapInPages', 'swapOutPages'):
                        require(old[name] <= g[name], 'Guest counter reset')
                    deltas = [b - a for a, b in zip(old['cpuTicks'], g['cpuTicks'])]
                    require(min(deltas) >= 0 and sum(deltas) > 0, 'CPU counters decreased or did not advance')
                    for name, s in obj['services'].items():
                        p = prev['services'].get(name)
                        if p and p['id'] == s['id'] and p['started'] == s['started'] and p['usage'] and s['usage']:
                            for field in ('cpuUs', 'oom', 'oomKills', 'initTicks'):
                                require(s['usage'][field] >= p['usage'][field], 'Service counter reset within generation')
                samples.append(obj)
            elif kind == 'event':
                fields(obj, 'atMs id action service'); digest(obj['id']); uint(obj['atMs'], 1)
                require(obj['service'] in allowed and obj['action'] in ACTIONS, 'Unexpected lifecycle event')
                events.append(obj)
            elif kind == 'end':
                fields(obj, 'samples eventsComplete')
                require(uint(obj['samples'], 3) == len(samples) and obj['eventsComplete'] is True, 'Incomplete capture footer')
                end = obj
            else:
                raise ValueError('Unexpected capture record')
    require(end is not None, 'Missing complete capture footer')
    require(samples[-1]['monoMs'] - samples[0]['monoMs'] + 1000 >= header['durationMs'], 'Truncated capture duration')
    return {'header': header, 'samples': samples, 'events': events, 'sha256': sha.hexdigest(), 'limits': caps, 'images': images}


def series(values):
    if not values:
        return None
    ordered = sorted(values)
    return {'n': len(values), 'p50': ordered[(len(values) - 1) // 2], 'p95': ordered[math.ceil(len(values) * .95) - 1],
            'max': ordered[-1]}


def summarize(trace, rows):
    header = trace['header']; hz = header['machine']['tickHz']
    g = [s['guest'] for s in rows]; first, last = g[0], g[-1]
    deltas = [[b - a for a, b in zip(left['cpuTicks'], right['cpuTicks'])] for left, right in zip(g, g[1:])]
    cpu = {name: series([round(100 * row[i] / sum(row), 3) for row in deltas])
           for i, name in ((0, 'busyPct'), (2, 'ioWaitPct'), (3, 'stealPct'))}
    cpu['nonIdlePct'] = series([round(100 * (sum(row) - row[1]) / sum(row), 3) for row in deltas])
    disks = {}
    for label, (total, used, _) in first['disks'].items():
        peak = max(row['disks'][label][1] for row in g)
        disks[label] = {'totalBytes': total, 'startUsedBytes': used, 'peakUsedBytes': peak, 'peakGrowthBytes': peak - used,
                        'endGrowthBytes': last['disks'][label][1] - used, 'minFreeBytes': min(row['disks'][label][2] for row in g)}
    peak = max(r['ramBytes'] - r['availableBytes'] for r in g)
    system = {'vcpus': first['vcpus'], 'ramBytes': first['ramBytes'], 'ramPeakBytes': peak,
              'ramPeakGrowthBytes': peak - (first['ramBytes'] - first['availableBytes']),
              'ramEndGrowthBytes': first['availableBytes'] - last['availableBytes'],
              'minAvailableBytes': min(r['availableBytes'] for r in g), 'swapBytes': first['swapBytes'],
              'swapUsedPeakBytes': max(r['swapUsedBytes'] for r in g), 'oomKills': last['oomKills'] - first['oomKills'],
              'swapInBytes': (last['swapInPages'] - first['swapInPages']) * header['machine']['pageBytes'],
              'swapOutBytes': (last['swapOutPages'] - first['swapOutPages']) * header['machine']['pageBytes'],
              'cpu': cpu, 'disks': disks}
    scoped = {}
    for name in MODES[header['mode']][header['role']][1]:
        known = [r['services'][name]['usage'] for r in rows if r['services'].get(name, {}).get('usage')]
        container_cpu, init_cpu = [], []
        for prev, row in zip(rows, rows[1:]):
            a, b = (s['services'].get(name) for s in (prev, row))
            if not (a and b and a['id'] == b['id'] and a['started'] == b['started'] and a['usage'] and b['usage']):
                continue  # Never subtract cumulative CPU across a replacement/restart or an unknown tick.
            seconds = (row['monoMs'] - prev['monoMs']) / 1000
            a, b = a['usage'], b['usage']
            container_cpu.append(round((b['cpuUs'] - a['cpuUs']) / (1_000_000 * seconds), 4))
            if a['initStartTicks'] == b['initStartTicks']:
                init_cpu.append(round((b['initTicks'] - a['initTicks']) / (hz * seconds), 4))
        scoped[name] = {'samplesWithUsage': len(known), 'cgroupRamPeakBytes': max((v['ramBytes'] for v in known), default=None),
                        'cpuCores': series(container_cpu), 'initProcessCpuCores': series(init_cpu),
                        'initProcessRssPeakBytes': max((v['initRssBytes'] for v in known), default=None),
                        'processRssSumPeakBytes': max((v['processRssBytes'] for v in known if not v['rssMissed']), default=None),
                        'rssPartialSamples': sum(bool(v['rssMissed']) for v in known),
                        'limits': trace['limits'].get(name), 'imageSha256': trace['images'].get(name)}
    # Compute simultaneous service peaks; a sum of independent per-service maxima is not a guest peak.
    totals = [sum(s['usage']['ramBytes'] for s in row['services'].values()) for row in rows
              if set(row['services']) == set(scoped) and all(s['usage'] for s in row['services'].values())]
    return {'sampleCount': len(rows), 'guest': system, 'services': scoped, 'serviceRamPeakBytes': max(totals, default=None)}
