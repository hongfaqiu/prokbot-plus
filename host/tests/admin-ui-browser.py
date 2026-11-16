"""Optional Chromium checks: python -B host/tests/admin-ui-browser.py [--artifacts DIR].

Only public assets are served on loopback. Every API response is a demo fixture;
other origins are blocked. No Host, saved browser profile or credentials needed.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from threading import Thread
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / 'server' / 'public'
FORMATS = ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages']
HTML = '<html><title>DEMO PROXY</title><body>Demo proxy page</body></html>'
ARTIFACTS = None


class Static(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class AdminUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        http = ThreadingHTTPServer(('127.0.0.1', 0), partial(Static, directory=PUBLIC))
        cls.origin = 'http://127.0.0.1:' + str(http.server_port)
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        cls.addClassCleanup(http.server_close)
        cls.addClassCleanup(thread.join)
        cls.addClassCleanup(http.shutdown)
        driver = sync_playwright().start()
        cls.addClassCleanup(driver.stop)
        cls.browser = driver.chromium.launch(args=['--disable-background-networking'])
        cls.addClassCleanup(cls.browser.close)

    def start(self, view='overview', *, mobile=False, locale='en-US', initial='ready', authenticated=True):
        self.mode, self.authenticated, self.reply = initial, authenticated, 'ok'
        self.requests, self.unexpected = [], []
        context = self.browser.new_context(locale=locale, timezone_id='UTC',
            viewport={'width': 390 if mobile else 1280, 'height': 844 if mobile else 900},
            is_mobile=mobile, has_touch=mobile, reduced_motion='reduce', service_workers='block')
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual(self.unexpected, []))
        context.route('**/*', self.route)
        self.page = context.new_page()
        self.page.on('pageerror', lambda error: self.unexpected.append(str(error)))
        self.page.clock.install()
        self.page.goto(self.origin + '/?view=' + view, wait_until='networkidle')
        return self.page

    def route(self, route):
        req = route.request
        parts = urlsplit(req.url)
        if parts.scheme + '://' + parts.netloc != self.origin:
            self.unexpected.append('off-origin request: ' + parts.netloc)
            return route.abort()
        if not parts.path.startswith('/admin/api/'):
            return route.continue_()
        key = parts.path.removeprefix('/admin/api/')
        self.requests.append((req.method, key))
        if key == 'session':
            return route.fulfill(json={'initialized': True, 'authenticated': self.authenticated})
        if key == 'login' and self.reply == 'ok':
            self.authenticated = True
            return route.fulfill(json={'ok': True})
        mode = self.mode if key == 'status' else self.reply if key in ('login', 'model/test', 'voice/test') else None
        if mode == 'dropped':
            return route.abort('connectionreset')
        if mode == 'stalled':
            self.stalled = route
            return
        if mode in ('401', '502'):
            return route.fulfill(status=int(mode), content_type='text/html', body=HTML)
        if mode == 'json401':
            return route.fulfill(status=401, json={'error': '管理员密码不正确' if key == 'login' else '请登录管理页面'})
        configured = self.mode != 'unconfigured'
        model = {'apiFormat': 'openai', 'model': 'demo-model' if configured else '',
            'baseUrl': 'https://model.example.invalid/v1', 'hasApiKey': configured,
            'configured': configured, 'reload': {'status': 'applied'},
            'policy': {'mode': 'manual', 'effort': 'default', 'classifierModel': 'jev-latest',
                'models': [{'id': 'demo-model', 'efforts': ['low']}], 'routes': {}}}
        fixtures = {'status': {'model': model, 'devices': [], 'pairingKeys': [], 'notifications': {},
                'publicUrl': 'https://demo.example.invalid',
                'host': {'connected': self.mode == 'ready', 'busy': False, 'agents': [],
                         'waitingForExecutionNode': self.mode == 'split-wait'}},
            'profile': {'displayName': 'Demo workspace', 'hostName': 'Demo Host', 'avatarDataUrl': None},
            'usage': {'requests': 0}, 'speech': {'enabled': False, 'provider': 'fish'},
            'voice': {'enabled': True, 'asr': {'configured': False}, 'tts': {'provider': 'openai',
                'endpoint': 'https://voice.example.invalid', 'model': 'demo', 'voice': 'demo', 'speed': 1}},
            'media': {'defaults': {}}, 'web-services': {'defaults': {}}, 'harness': {}, 'skills': [],
            'apps': {'apps': []}, 'network': {'enabled': False}, 'execution': {'enabled': False, 'url': '', 'name': 'Demo node'},
            'federation': {'peers': []}, 'webhooks': [], 'sharing': []}
        if key not in fixtures:
            self.unexpected.append('unexpected demo API: ' + key)
            return route.fulfill(status=404, json={'error': 'Unknown demo endpoint'})
        return route.fulfill(json=fixtures[key])

    def poll(self, mode):
        self.mode = mode
        event = 'requestfailed' if mode == 'dropped' else 'response'
        with self.page.expect_event(event, predicate=lambda r: r.url.endswith('/admin/api/status')):
            self.page.clock.fast_forward(5000)
        self.page.wait_for_load_state('networkidle')

    def capture(self, name, **data):
        if ARTIFACTS:
            self.page.screenshot(path=ARTIFACTS / (name + '.png'), animations='disabled')
            (ARTIFACTS / (name + '.json')).write_text(json.dumps({**data, 'requests': self.requests},
                ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    def test_split_wait_points_to_the_real_execution_editor(self):
        page = self.start(mobile=True, initial='split-wait')
        expect(page.locator('#header-health')).to_have_text('Execution node required')
        action = page.locator('#attention-list button[data-view=execution]')
        expect(action).to_have_text('Set up node')
        self.capture('split-wait', action=action.inner_text())
        action.click()
        expect(page.locator('#execution-form')).to_be_visible()
        self.assertIn(('GET', 'execution'), self.requests)

    def test_status_loss_and_recovery(self):
        page = self.start()
        header, hero = page.locator('#header-health'), page.locator('#hero-title')
        expect(header).to_have_text('Host ready')
        self.poll('core-down')
        expect(header).to_have_text('Waiting for Host')
        self.poll('ready')
        for mode in ['dropped', '502']:
            with self.subTest(mode=mode):
                self.poll(mode)
                self.capture('status-' + mode, header=header.inner_text(), tone=header.get_attribute('data-tone'),
                             headline=hero.inner_text())
                self.assertNotEqual(header.get_attribute('data-tone'), 'success')
                self.assertEqual(header.inner_text(), 'Status unavailable')
                self.assertEqual(hero.inner_text(), 'Status unavailable')
                expect(page.locator('#hero-host')).to_be_hidden()
                if mode == '502':
                    expect(page.locator('.hero-copy')).to_contain_text('502')
                expect(page.locator('body')).not_to_contain_text('DEMO PROXY')
            self.poll('ready')
            expect(hero).to_have_text('Host ready')
            expect(header).to_have_attribute('data-tone', 'success')

    def test_offline_and_stalled_poll(self):
        page = self.start()
        header = page.locator('#header-health')
        expect(header).to_have_text('Host ready')
        self.mode = 'dropped'
        page.context.set_offline(True)
        expect(header).to_have_text('Status unavailable', timeout=1500)
        self.mode = 'ready'
        page.context.set_offline(False)
        expect(header).to_have_text('Host ready', timeout=2000)
        self.mode = 'stalled'
        with page.expect_request(lambda r: r.url.endswith('/admin/api/status')):
            page.clock.fast_forward(5000)
        page.clock.run_for(12050)
        expect(header).to_have_text('Status unavailable')
        expect(page.locator('#hero-status-error')).to_have_text('Host status request timed out.')
        self.stalled.abort()
        self.poll('ready')
        expect(header).to_have_text('Host ready')

    def test_first_status_expired(self):
        page = self.start(view='model', initial='json401')
        expect(page.locator('#auth-screen')).to_be_visible()
        first = len(self.requests)
        for _ in range(2):
            page.clock.fast_forward(5000)
            page.wait_for_load_state('networkidle')
        self.capture('first-status-expired', notice=page.locator('#auth-error').text_content(),
                     extra_requests=len(self.requests) - first)
        self.assertEqual(self.requests, [('GET', 'session'), ('GET', 'status')])
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#auth-password')).to_be_focused()
        self.mode = 'ready'
        page.keyboard.type('demo-password-only')
        page.keyboard.press('Enter')
        expect(page.locator('#header-health')).to_have_text('Host ready')
        self.poll('core-down')
        expect(page.locator('#header-health')).to_have_text('Waiting for Host')

    def test_proxy_expiry_during_poll(self):
        page = self.start()
        self.poll('401')
        first = len(self.requests)
        page.clock.fast_forward(10000)
        page.wait_for_load_state('networkidle')
        self.capture('poll-html-401', notice=page.locator('#auth-error').text_content(),
                     auth_visible=page.locator('#auth-screen').is_visible(), extra_requests=len(self.requests) - first)
        self.assertEqual(self.requests[first:], [])
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#console')).to_be_hidden()

    def test_login_proxy_and_json_errors(self):
        page = self.start(authenticated=False)
        field = page.get_by_label('Admin password', exact=True)
        for reply, message in [('401', '401'), ('502', '502'), ('json401', 'Incorrect administrator password')]:
            with self.subTest(reply=reply):
                self.reply = reply
                field.fill('demo-password-only')
                with page.expect_event('requestfinished', predicate=lambda r: r.url.endswith('/admin/api/login')):
                    field.press('Enter')
                alert = page.locator('#auth-error')
                expect(alert).to_be_visible()
                self.capture('login-' + reply, notice=alert.inner_text())
                self.assertIn(message, alert.inner_text())
                self.assertNotRegex(alert.inner_text(), r'(?i)<html|<!doctype|DEMO PROXY|unexpected token|expired')

    def test_mobile_english_keyboard(self):
        page = self.start(mobile=True, initial='unconfigured')
        hint = page.locator('#attention-list .row-hint').first.inner_text()
        layout = page.evaluate('''() => {
            const range = document.createRange();
            const right = Math.max(...[...document.querySelectorAll('#hero-title span')].map(line => {
                range.selectNodeContents(line); return range.getBoundingClientRect().right;
            }));
            return {textRight: right, iconLeft: document.querySelector('#hero-host').getBoundingClientRect().left};
        }''')
        self.capture('mobile-setup', hint=hint, layout=layout)
        self.assertLessEqual(layout['textRight'], layout['iconLeft'])
        menu = page.get_by_role('button', name='Menu', exact=True)
        page.keyboard.press('Tab')  # brand link
        page.keyboard.press('Tab')
        expect(menu).to_be_focused()
        page.keyboard.press('Space')
        expect(menu).to_have_attribute('aria-expanded', 'true')
        page.keyboard.press('Tab')  # Overview
        page.keyboard.press('Tab')
        link = page.locator('#nav [data-view=model]')
        expect(link).to_be_focused()
        page.keyboard.press('Enter')
        expect(link).to_have_attribute('aria-current', 'page')
        expect(menu).to_have_attribute('aria-expanded', 'false')
        select = page.get_by_role('combobox', name=re.compile('API format'))
        self.assertEqual(select.locator('option').all_text_contents(), FORMATS)
        select.focus()
        page.keyboard.press('ArrowDown')
        expect(select).to_have_value('openai-responses')
        page.keyboard.press('End')
        expect(select).to_have_value('anthropic')
        self.reply = '502'
        page.get_by_role('button', name='Test connection').press('Enter')
        error = page.locator('#model-error')
        expect(error).to_be_visible()
        self.capture('mobile-model-error', notice=error.inner_text(), format=select.input_value())
        self.assertEqual(error.inner_text(), 'Request failed (502)')
        self.assertTrue(all(label in hint for label in FORMATS))
        self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

    def test_chinese_setup_copy(self):
        page = self.start(initial='unconfigured', locale='zh-CN')
        hint = page.locator('#attention-list .row-hint').first.inner_text()
        self.capture('zh-setup', hint=hint)
        self.assertTrue(all(label in hint for label in FORMATS))

    def test_voice_proxy_errors(self):
        page = self.start(view='speech')
        button, error = page.locator('#voice-preview'), page.locator('#voice-error')
        self.reply = '502'
        button.press('Enter')
        expect(error).to_be_visible()
        self.capture('voice-502', notice=error.inner_text())
        with self.subTest(status=502):
            self.assertEqual(error.inner_text(), 'Request failed (502)')
        self.reply = '401'
        with page.expect_response(lambda r: r.url.endswith('/admin/api/voice/test')):
            button.press('Enter')
        expect(page.locator('#auth-error')).to_have_text('Session expired. Sign in again.')
        expect(page.locator('#console')).to_be_hidden()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path)
    args, rest = parser.parse_known_args()
    ARTIFACTS = args.artifacts
    if ARTIFACTS:
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
    unittest.main(argv=[__file__, *rest], verbosity=2)
