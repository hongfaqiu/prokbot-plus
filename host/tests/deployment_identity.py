"""Same-daemon identity and shared-tag transactions, without a Docker socket."""
import contextlib
import io
import json
import subprocess
import unittest
from unittest.mock import patch

import deployment_volumes as fixtures
from deployment_volumes import backup, deploy, PROJECT, HOST_TAG, OLD, NEW


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.VolumeTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.engine = self.f.e
        self.source = self.f.source

    def home(self, project, port):
        args = ['--home', str(self.f.home.parent/('home-'+project)), '--project', project]
        deploy.main([*args, '--host-only', 'init', '--port', str(port)])
        return args

    def original(self):
        home = self.home(PROJECT, 18080)
        self.f.snapshot(('host',))
        self.engine.docker(['stop', 'demo-host'])
        return home

    def recover(self, args, source=None):
        deploy.main([*args, 'recover', '--directory', str(source or self.source)])

    def assert_no_activation(self, call):
        start = len(self.engine.calls)
        with self.assertRaises((ValueError, RuntimeError)):
            call()
        self.assertFalse(any(c[0] in ('build', 'stop', 'start', 'pause', 'run') or 'up' in c for c in self.engine.calls[start:]))

    def test_same_backup_cannot_start_twice_on_two_ports(self):
        self.original()
        first = self.home('first', 18081)
        second = self.home('second', 18082)
        self.recover(first)
        self.assert_no_activation(lambda: self.recover(second))
        self.assertEqual(self.engine.containers['first-host']['State']['Status'], 'running')
        self.assertNotIn('second_host-data', self.engine.labels)

    def test_nested_snapshot_keeps_root_and_prevents_original_or_sibling_restart(self):
        origin = self.original()
        first = self.home('first', 18081)
        self.recover(first)
        nested = self.f.home.parent/'nested'
        backup.backup('first', nested, OLD)
        self.engine.docker(['stop', 'first-host'])
        self.recover(self.home('nested', 18082), nested)
        self.assert_no_activation(lambda: deploy.main([*origin, 'update']))
        self.assert_no_activation(lambda: deploy.main([*first, 'update']))
        self.assert_no_activation(lambda: self.recover(self.home('sibling', 18083)))
        self.assertEqual(self.engine.containers['nested-host']['State']['Status'], 'running')

    def test_concurrent_recovery_via_different_immediate_parents_has_one_winner(self):
        self.original()
        first = self.home('first', 18081)
        self.recover(first)
        nested = self.f.home.parent/'nested'
        backup.backup('first', nested, OLD)
        self.engine.docker(['stop', 'first-host'])
        other = self.home('other', 18082)
        target = self.home('target', 18083)
        def competing():
            self.engine.before_up = lambda: None
            self.assert_no_activation(lambda: self.recover(other, nested))
        self.engine.before_up = competing
        self.recover(target)
        self.assertNotIn('other_host-data', self.engine.labels)
        self.assertEqual(self.engine.containers['target-host']['State']['Status'], 'running')

    def test_only_unmarked_legacy_restored_volumes_do_not_prove_a_distinct_identity(self):
        origin = self.original()
        target = self.home('target', 18082)
        self.engine.volume('legacy_host-data', {'com.docker.compose.project':'legacy', 'com.docker.compose.volume':'host-data'})
        self.assert_no_activation(lambda: self.recover(target))
        self.assert_no_activation(lambda: deploy.main([*origin, 'update']))
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'exited')

    def test_legacy_restore_id_without_lineage_cannot_be_promoted_by_a_new_backup(self):
        self.original()
        self.engine.stack(('host',), project='oldcopy')
        self.engine.labels['oldcopy_host-data'][backup.RESTORE_LABEL] = 'old-operation'
        self.engine.docker(['stop', 'oldcopy-host'])
        unknown = self.f.home.parent/'legacy-snapshot'
        backup.backup('oldcopy', unknown, OLD)
        self.assert_no_activation(lambda: self.recover(self.home('target', 18082), unknown))
        self.assert_no_activation(lambda: deploy.main([*self.home('oldcopy', 18081), 'update']))

    def test_recover_without_lineage_is_data_only_even_if_image_ids_exist(self):
        self.original()
        path = self.source/'manifest.json'
        manifest = json.loads(path.read_bytes())
        manifest.pop('lineageRoot', None)
        path.write_text(json.dumps(manifest))
        self.assert_no_activation(lambda: self.recover(self.home('target', 18082)))
        backup.restore(self.source, 'offline', OLD)
        self.assertFalse(self.engine.ids('offline'))

    def test_solitary_unmarked_legacy_volume_never_becomes_its_own_root(self):
        self.engine.stack(('host',))
        self.engine.labels['demo_host-data'].pop('com.docker.compose.version')
        self.engine.docker(['stop', 'demo-host'])
        backup.backup(PROJECT, self.source, OLD)
        self.assertIsNone(json.loads((self.source/'manifest.json').read_bytes()).get('lineageRoot'))
        self.assert_no_activation(lambda: self.recover(self.home('target', 18082)))
        self.assert_no_activation(lambda: deploy.main([*self.home(PROJECT, 18080), 'update']))

    def test_foreign_compose_volumes_and_own_lock_suffix_do_not_block_managed_operations(self):
        origin = self.original()
        for name, role in [('cache_host-data', 'cache-data'), ('custom-database', 'host-data')]:
            self.engine.volume(name, {backup.PROJECT_LABEL: 'other', backup.VOLUME_LABEL: role, backup.VERSION_LABEL: '2.40.3'})
        deploy.main([*origin, 'backup'])
        deploy.main([*self.home('team_host-data', 18085), 'up'])
        self.recover(self.home('restored', 18086))
        self.assertEqual(self.engine.containers['restored-host']['State']['Status'], 'running')

    def test_unknown_offline_restore_stays_offline_but_does_not_block_creation_of_empty_new_identity(self):
        origin = self.original(); path = self.source/'manifest.json'
        manifest = json.loads(path.read_bytes()); manifest.pop('lineageRoot'); path.write_text(json.dumps(manifest))
        backup.restore(self.source, 'offline', OLD)
        self.assert_no_activation(lambda: deploy.main([*origin, 'update']))
        deploy.main([*self.home('fresh', 18087), 'up'])
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'running')
        self.assertEqual(self.engine.ids('offline'), [])

    def test_unlabelled_foreign_volume_user_or_unreadable_state_cannot_bypass_lineage_gate(self):
        self.original()
        mounts = self.engine.containers['demo-host']['Mounts']
        cid = self.engine.container('other', 'outside', mounts, OLD)
        self.engine.containers[cid]['Config']['Labels'] = {'com.docker.compose.project': 'outside'}
        target = self.home('target', 18082)
        self.assert_no_activation(lambda: self.recover(target))
        self.engine.fail = lambda c: c[0] == 'inspect' and c[-1] == cid
        with self.assertRaises(subprocess.CalledProcessError): self.recover(target)
        self.assertNotIn('target_host-data', self.engine.labels)

    def test_stopped_sibling_can_transfer_activation_and_unrelated_managed_hosts_can_coexist(self):
        self.original()
        self.recover(self.home('first', 18081))
        self.engine.docker(['stop', 'first-host'])
        self.recover(self.home('second', 18082))
        self.assertEqual(self.engine.containers['second-host']['State']['Status'], 'running')
        self.engine.docker(['stop', 'second-host'])
        fresh = self.home('fresh', 18083)
        deploy.main([*fresh, 'up'])
        self.recover(self.home('third', 18084))
        self.assertTrue(all(self.engine.containers[n+'-host']['State']['Status'] == 'running' for n in ('fresh', 'third')))

    def test_update_recovered_host_with_only_immutable_image_and_no_public_tag(self):
        self.original()
        target = self.home('restored', 18081)
        del self.engine.images[HOST_TAG]
        self.recover(target)
        deploy.main([*target, 'update'])
        self.assertEqual(self.engine.images[HOST_TAG], NEW)
        self.assertEqual(self.engine.containers['restored-host']['Image'], NEW)
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'exited')

    def test_inventory_error_is_never_treated_as_a_missing_tag(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        del self.engine.images[HOST_TAG]
        self.engine.fail = lambda c: c[:2] == ['image','ls']
        with self.assertRaises(subprocess.CalledProcessError): self.f.invoke('update')
        self.assertTrue(any(c[:2] == ['image','ls'] for c in self.engine.calls))
        self.assertFalse(any(c[0] in ('build','stop') for c in self.engine.calls))

    def test_failed_inspect_of_listed_tag_is_not_absence(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        self.engine.fail = lambda c: c[:2] == ['image','inspect'] and c[-1] == HOST_TAG
        with self.assertRaises(subprocess.CalledProcessError): self.f.invoke('update')
        self.assertEqual(self.engine.images[HOST_TAG], OLD)
        self.assertFalse(any(c[0] in ('build','stop') for c in self.engine.calls))

    def test_repository_without_tag_queries_only_latest_not_all_repository_tags(self):
        with patch.object(deploy, 'run', wraps=deploy.run) as calls:
            self.assertIsNone(deploy.tag_state('grokbot-host'))
        self.assertEqual(calls.call_args.args[0][-1], 'grokbot-host:latest')

    def test_new_install_failure_restores_existing_public_tag_of_other_projects(self):
        fresh = self.home('fresh', 18083)
        self.engine.unhealthy = True
        with self.assertRaises(RuntimeError): deploy.main([*fresh, 'up'])
        self.assertEqual(self.engine.images[HOST_TAG], OLD)
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'exited')
        self.assertTrue((self.f.restored('fresh','host-data')/'partial-migration').exists())

    def test_external_tag_change_is_never_clobbered_by_rollback(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        other = 'sha256:' + '9'*64
        command = self.engine.docker
        def concurrent(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) == ['image', 'tag', NEW, HOST_TAG]:
                self.engine.images[HOST_TAG] = other
                self.engine.error(cmd)
            return result
        with patch.object(self.engine, 'docker', concurrent), self.assertRaisesRegex(RuntimeError, 'rollback NOT confirmed'):
            self.f.invoke('update')
        self.assertEqual(self.engine.images[HOST_TAG], other)
        self.assertEqual(self.engine.containers['demo-host']['Image'], OLD)
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'running')

    def test_lost_rollback_ack_is_verified_by_observation_without_removing_old_image(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        del self.engine.images[HOST_TAG]
        command = self.engine.docker
        def uncertain(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) in (['image', 'tag', NEW, HOST_TAG], ['image','rm','--no-prune',HOST_TAG]): self.engine.error(cmd)
            return result
        with patch.object(self.engine, 'docker', uncertain), self.assertRaises(subprocess.CalledProcessError): self.f.invoke('update')
        self.assertNotIn(HOST_TAG, self.engine.images)
        self.assertIn(OLD, self.engine.image_ids)
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'running')

    def test_lost_publication_ack_with_originally_absent_tag_removes_only_new_alias(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        del self.engine.images[HOST_TAG]
        command = self.engine.docker
        def uncertain(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) == ['image', 'tag', NEW, HOST_TAG]: self.engine.error(cmd)
            return result
        with patch.object(self.engine, 'docker', uncertain), self.assertRaises(subprocess.CalledProcessError): self.f.invoke('update')
        self.assertIn(['image', 'tag', NEW, HOST_TAG], self.engine.calls)
        self.assertNotIn(HOST_TAG, self.engine.images)
        self.assertEqual(self.engine.containers['demo-host']['Image'], OLD)
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'running')

    def test_failed_candidate_restores_prior_tag_state_but_never_starts_old_image_on_migrated_data(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        del self.engine.images[HOST_TAG]
        self.engine.unhealthy = True
        with self.assertRaisesRegex(RuntimeError, 'Project services are stopped'): self.f.invoke('update')
        self.assertNotIn(HOST_TAG, self.engine.images)
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'exited')
        self.assertTrue((self.f.restored(PROJECT,'host-data')/'partial-migration').exists())
        self.assertTrue(list((self.f.home/'backups').glob('*/manifest.json')))
        self.assertFalse(any(c[0] == 'start' for c in self.engine.calls))

    def test_competing_project_cannot_publish_same_tag_inside_first_transaction(self):
        first = self.home('first', 18081)
        second = self.home('second', 18082)
        deploy.main([*first, 'up'])
        deploy.main([*second, 'up'])
        def competing():
            self.engine.before_up = lambda: None
            self.assert_no_activation(lambda: deploy.main([*second, 'update']))
        self.engine.before_up = competing
        deploy.main([*first, 'update'])
        self.assertEqual(self.engine.containers['second-host']['State']['Status'], 'running')

    def unknown_offline_fixture(self):
        self.original()
        path = self.source/'manifest.json'
        known = json.loads(path.read_bytes())
        legacy = self.f.home.parent/'legacy-offline'
        # Keep the known snapshot available for an independent recovery attempt.
        legacy.mkdir()
        for record in known['volumes']:
            (legacy/record['file']).write_bytes((self.source/record['file']).read_bytes())
        (legacy/'manifest.json').write_text(json.dumps({k: v for k, v in known.items() if k != 'lineageRoot'}))
        backup.restore(legacy, 'offline', OLD)
        self.assertFalse(self.engine.ids('offline'))
        return self.f.restored('offline', 'host-data')/'payload'

    def test_gate_unlabelled_cache_appearing_after_stop_allows_update_and_recovery(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        command = self.engine.docker
        def cache_arrives(cmd, **kw):
            result = command(cmd, **kw)
            if list(cmd) == ['stop', 'demo-host']:
                path = self.engine.volume('cache_host-data', {})
                (path/'sentinel').write_bytes(b'external fixture')
                self.engine.container('cache', 'other', [{'Type': 'volume', 'Name': 'cache_host-data',
                                                          'Destination': '/cache', 'RW': True}], OLD)
            return result
        with patch.object(self.engine, 'docker', cache_arrives):
            self.f.invoke('update')
        self.assertEqual(self.engine.containers['demo-host']['Image'], NEW)
        self.engine.docker(['stop', 'demo-host'])
        manifests = list((self.f.home/'backups').glob('*/manifest.json'))
        self.assertEqual(len(manifests), 1)
        self.recover(self.home('recovered', 18081), manifests[0].parent)
        self.assertEqual(self.engine.containers['recovered-host']['Image'], OLD)
        self.assertEqual((self.f.restored('recovered','host-data')/'payload').read_bytes(), b'host-data: original')
        self.assertEqual(self.engine.labels['cache_host-data'], {})
        self.assertEqual((self.engine.root/'cache_host-data'/'sentinel').read_bytes(), b'external fixture')
        self.assertEqual(self.engine.containers['other-cache']['State']['Status'], 'running')
        self.assertFalse(any(c[0] == 'run' and any('src=cache_host-data,' in v for v in c) for c in self.engine.calls))

    def test_gate_unlabelled_cache_during_failed_backup_does_not_strand_original(self):
        self.f.invoke('--host-only', 'init')
        self.engine.stack(('host',))
        command = self.engine.docker
        def fail_archive(cmd, **kw):
            if cmd[0] == 'run' and '-czf' in cmd:
                self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'exited')
                self.engine.volume('cache_host-data', {})
                self.engine.error(cmd)
            return command(cmd, **kw)
        with patch.object(self.engine, 'docker', fail_archive), self.assertRaises(subprocess.CalledProcessError):
            self.f.invoke('update')
        self.assertEqual([c for c in self.engine.calls if c[0] == 'start'], [['start','demo-host']])
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'running')
        self.assertEqual(self.engine.containers['demo-host']['Image'], OLD)
        self.assertEqual(self.engine.images[HOST_TAG], OLD)
        self.assertFalse(any('up' in c for c in self.engine.calls))
        self.assertIn('cache_host-data', self.engine.labels)

    def test_gate_first_update_of_fresh_running_host_never_activates_offline_copy(self):
        offline = self.unknown_offline_fixture()
        prior_bytes = offline.read_bytes()
        fresh = self.home('fresh', 18082)
        deploy.main([*fresh, 'up'])
        active = self.f.restored('fresh', 'host-data')/'payload'
        active.write_bytes(b'only the fresh instance')
        start = len(self.engine.calls)
        deploy.main([*fresh, 'update'])
        ops = self.engine.calls[start:]
        self.assertEqual([c for c in ops if c[0] == 'stop'], [['stop','fresh-host']])
        self.assertEqual([c[c.index('-p')+1] for c in ops if c[0] == 'compose' and 'up' in c], ['fresh'])
        archives = [c[c.index('--mount')+1] for c in ops if c[0] == 'run' and '-czf' in c]
        self.assertEqual(len(archives), 1)
        self.assertIn('src=fresh_host-data,', archives[0])
        self.assertFalse(any(c[0] == 'run' and '-xzf' in c for c in ops))
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'running')
        self.assertEqual(self.engine.containers['demo-host']['State']['Status'], 'exited')
        self.assertEqual(self.engine.ids('offline'), [])
        self.assertEqual(offline.read_bytes(), prior_bytes)
        self.assertEqual(active.read_bytes(), b'only the fresh instance')

    def test_gate_failed_first_update_resumes_only_previously_running_fresh_host(self):
        offline = self.unknown_offline_fixture()
        fresh = self.home('fresh', 18082)
        deploy.main([*fresh, 'up'])
        original_image = self.engine.containers['fresh-host']['Image']
        start = len(self.engine.calls)
        self.engine.fail = lambda c: c[0] == 'run' and '-czf' in c
        with self.assertRaises(subprocess.CalledProcessError): deploy.main([*fresh, 'update'])
        self.assertEqual([c for c in self.engine.calls[start:] if c[0] in ('stop','start')],
                         [['stop','fresh-host'], ['start','fresh-host']])
        self.assertEqual(self.engine.containers['fresh-host']['Image'], original_image)
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'running')
        self.assertEqual(self.engine.ids('offline'), [])
        self.assertEqual(offline.read_bytes(), b'host-data: original')

    def test_failed_takeover_with_unknown_offline_copy_explains_offline_restore_before_stop(self):
        offline = self.unknown_offline_fixture()
        fresh = self.home('fresh', 18082)
        deploy.main([*fresh, 'up'])
        data = self.f.restored('fresh', 'host-data')/'payload'
        previous = self.engine.containers['fresh-host']['Image']
        data.write_bytes(b'fresh before takeover')
        self.engine.unhealthy = True
        phases, command = [], self.engine.docker
        def record(cmd, **kw):
            if cmd[0] == 'stop': phases.append('stop')
            return command(cmd, **kw)
        def report(text, **kw):
            if 'automatic recovery is blocked' in str(text): phases.append('warning')
        with patch.object(self.engine, 'docker', record), patch('builtins.print', side_effect=report):
            with self.assertRaises(RuntimeError) as failure: deploy.main([*fresh, 'update'])
        self.assertTrue((data.parent/'partial-migration').is_file())
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'exited')
        saved = list((self.f.home.parent/'home-fresh'/'backups').glob('*/manifest.json'))
        self.assertEqual(len(saved), 1)
        source = saved[0].parent
        self.assert_no_activation(lambda: self.recover(self.home('unused', 18083), source))
        backup.restore(source, 'checked', previous)
        self.assertFalse(self.engine.ids('checked')); self.assertFalse(self.engine.ids('offline'))
        self.assertEqual(offline.read_bytes(), b'host-data: original')
        self.assertEqual((self.f.restored('checked', 'host-data')/'payload').read_bytes(), b'fresh before takeover')
        self.assertFalse((self.f.restored('checked', 'host-data')/'partial-migration').exists())
        self.assertIn('automatic recovery is blocked', str(failure.exception))
        self.assertIn('data-only restore', str(failure.exception))
        self.assertIn(str(source), str(failure.exception))
        self.assertNotIn('Run recover --directory', str(failure.exception))
        self.assertEqual(phases[:2], ['warning', 'stop'])

    def test_gate_unknown_copy_with_actual_host_mount_blocks_fresh_up_and_running_update(self):
        offline = self.unknown_offline_fixture()
        fresh = self.home('fresh', 18082)
        deploy.main([*fresh, 'up'])
        blank = self.home('blank', 18083)
        cid = self.engine.container('host', 'third-party', [{'Type':'volume', 'Name':'offline_host-data',
                                                           'Destination':'/data', 'RW':True}], OLD)
        self.assertFalse(self.engine.ids('offline'))  # Project ownership alone misses this consumer.
        for status in ('running','paused'):
            if status == 'paused': self.engine.docker(['pause', cid])
            for args, action in ((blank,'up'), (fresh,'update')):
                with self.subTest(status=status, action=action):
                    self.assert_no_activation(lambda: deploy.main([*args, action]))
            self.assertEqual(self.engine.containers[cid]['State']['Status'], status)
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'running')
        self.assertNotIn('blank_host-data', self.engine.labels)
        self.assertEqual(offline.read_bytes(), b'host-data: original')

    def test_gate_unknown_copy_becoming_active_during_backup_blocks_resume(self):
        offline = self.unknown_offline_fixture()
        fresh = self.home('fresh', 18082)
        deploy.main([*fresh, 'up'])
        start = len(self.engine.calls)
        command = self.engine.docker
        def peer_appears(cmd, **kw):
            if cmd[0] == 'run' and '-czf' in cmd:
                self.engine.container('host', 'other', [{'Type':'volume', 'Name':'offline_host-data',
                                                       'Destination':'/data', 'RW':True}], OLD)
                self.engine.error(cmd)
            return command(cmd, **kw)
        with patch.object(self.engine, 'docker', peer_appears), self.assertRaises((ValueError, RuntimeError)):
            deploy.main([*fresh, 'update'])
        ops = self.engine.calls[start:]
        self.assertIn(['stop','fresh-host'], ops)  # A blanket preflight refusal is not a pass.
        self.assertFalse(any(c[0] == 'start' or 'up' in c for c in ops))
        self.assertEqual(self.engine.containers['fresh-host']['State']['Status'], 'exited')
        self.assertEqual(self.engine.containers['other-host']['State']['Status'], 'running')
        self.assertEqual(offline.read_bytes(), b'host-data: original')

    def test_gate_unlabelled_cache_and_offline_restore_still_block_exact_target_collision(self):
        offline = self.unknown_offline_fixture()
        cache = self.engine.volume('cache_host-data', {})/'sentinel'
        cache.write_bytes(b'external fixture')
        for project, port in [('cache',18082), ('offline',18083)]:
            target = self.home(project, port)
            for action in ('up','recover'):
                with self.subTest(project=project, action=action):
                    self.assert_no_activation(lambda: deploy.main([*target, 'up']) if action == 'up' else self.recover(target))
            self.assertEqual(self.engine.ids(project), [])
        self.assertEqual(cache.read_bytes(), b'external fixture')
        self.assertEqual(offline.read_bytes(), b'host-data: original')


if __name__ == '__main__':
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
