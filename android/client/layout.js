// Layout for phone-width windows: the parts CSS alone cannot express.

/** Below this width the window is a phone: the Bot list and a conversation are separate screens. */
export const PHONE_QUERY = '(max-width: 599px)';

const BACK_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const SHARE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3v12"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>';
const MORE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
  + '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
const CLOCK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const FOLDER_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const MONITOR_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const REPLY_SWIPE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';

const SWIPE_SLOP_PX = 10;
const SWIPE_TRIGGER_PX = 56;
const SWIPE_MAX_PX = 76;
const REPLY_LABEL_RE = /reply|回复|回覆|respond|antworten|répondre|responder|rispondi|ответить|返信|답장/i;
const EXPAND_LABEL_RE = /expand|展开|展開|fullscreen|全屏|全螢幕/i;

/** Maps a left-swipe delta (`dx < 0`) to bounded bubble translation with rubber-band resistance beyond `threshold`. */
export function swipeReplyDisplacement(dx, threshold = SWIPE_TRIGGER_PX, maxDrag = SWIPE_MAX_PX) {
  if (!Number.isFinite(dx) || dx >= 0) return 0;
  const dist = -dx;
  if (dist <= threshold) return -dist;
  return -Math.min(threshold + Math.sqrt(dist - threshold) * 2, maxDrag);
}

/** Resolves the native Reply button rendered inside `.sand-message-hover-actions` of an action anchor. */
export function findReplyActionButton(anchor) {
  if (!anchor) return null;
  const buttons = [...anchor.querySelectorAll('.sand-message-hover-actions button')];
  if (!buttons.length) return null;
  const labeled = buttons.find(btn => REPLY_LABEL_RE.test(btn.getAttribute('aria-label') || ''));
  if (labeled) return labeled;
  const nonMenu = buttons.filter(btn =>
    !btn.hasAttribute('aria-haspopup') && !EXPAND_LABEL_RE.test(btn.getAttribute('aria-label') || ''),
  );
  return nonMenu.length ? nonMenu[nonMenu.length - 1] : null;
}

const fittedFrames = new WeakMap();
/**
 * Image attachments get a fixed inline size (for example 320 x 180) chosen for desktop
 * message columns. On a phone the column can be narrower, so the frame is scaled down
 * with its aspect ratio kept. A later render that restores the size is fitted again.
 */
export function fitAttachmentFrames(root = document) {
  for (const frame of root.querySelectorAll('.sand-attachment__image-frame[style]')) {
    const currentWidth = frame.style.width, currentHeight = frame.style.height;
    if (!currentWidth.endsWith('px') || !currentHeight.endsWith('px')) continue;
    const last = fittedFrames.get(frame);
    const unchanged = last && currentWidth === last.fittedWidth && currentHeight === last.fittedHeight;
    const width = unchanged ? last.width : Number.parseFloat(currentWidth);
    const height = unchanged ? last.height : Number.parseFloat(currentHeight);
    const available = frame.parentElement?.clientWidth ?? 0;
    if (!(width > 0 && height > 0 && available > 0)) continue;
    const fittedWidth = `${Math.min(width, available)}px`;
    const fittedHeight = `${width > available ? Math.round(height * available / width) : height}px`;
    if (width > available) fittedFrames.set(frame, { width, height, fittedWidth, fittedHeight });
    else fittedFrames.delete(frame);
    if (currentWidth !== fittedWidth) frame.style.width = fittedWidth;
    if (currentHeight !== fittedHeight) frame.style.height = fittedHeight;
  }
}

/** The large Bot computer view stays mounted after it is closed; only its visibility changes. */
export function computerStageOpen(root = document) {
  const stage = root.querySelector('.sand-computer-fullscreen');
  return stage != null && getComputedStyle(stage).visibility !== 'hidden';
}

/** True while the details pane covers the conversation as a full-screen layer (android.css). */
export function paneLayerOpen(root = document) {
  const pane = root.querySelector('.sand-info-pane[data-open="true"]');
  return pane != null && matchMedia('(max-width: 791px)').matches && getComputedStyle(pane).visibility !== 'hidden';
}

/**
 * Which phone screen should show after the selected Bot changed from `previous` to `current`.
 * In the list, a Bot the user just created opens its conversation (`creating`: the user pressed
 * "Create" a moment ago, and the Host may take a while to answer); any other change (deleting
 * the selected Bot, the list loading) keeps the list. In a conversation the screen stays, unless
 * the Bot was deleted (`previousListed` is false), which returns to the list.
 */
export function screenAfterAgentChange({ previous, current, screen, previousListed, currentKnown, userCaused, creating = false }) {
  if (previous === undefined || previous === current) return screen;
  if (screen === 'chat') return previous !== null && !previousListed ? 'list' : 'chat';
  if (current !== null && creating) return 'chat';
  return current !== null && !currentKnown && userCaused ? 'chat' : 'list';
}

/**
 * When a Bot was last active, as the official phone app shows it at the right of each row:
 * the time for today, "Yesterday", the weekday within a week, otherwise the date.
 */
export function activityTime(at, now = Date.now(), locale = 'en') {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at), today = new Date(now);
  const day = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(today) - day(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
  }
  if (days < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  return date.toLocaleDateString(locale, date.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
// Called by the patched Bot row (patchers/renderer-patches.mjs).
globalThis.grokbotActivityTime = at => activityTime(at, Date.now(), document.documentElement.lang || navigator.language);

/**
 * Formats the unread jump pill like the official phone app ("1个未读" / "1 unread")
 * from the desktop button's `title` ("1 条未读消息" / "1 unread message").
 */
export function formatMoreUnreadsLabel(title, zh = isZhLocale()) {
  const match = typeof title === 'string' ? title.match(/\d[\d,]*/) : null;
  if (!match) return null;
  const count = Number.parseInt(match[0].replaceAll(',', ''), 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (/未讀/.test(title)) return `${count}個未讀`;
  const useZh = /未读/.test(title) ? true : /\bunread\b/i.test(title) ? false : zh;
  return useZh ? `${count}个未读` : `${count} unread`;
}

const phone = {
  query: null,
  screen: 'list',
  agent: undefined,
  known: new Set(),
  deleted: null,
  newChat: false,
  interactedAt: -Infinity,
  creatingAt: -Infinity,
  shownAt: -Infinity,
  fieldPointerAt: -Infinity,
  back: null,
  infoOpen: false,
  infoMode: 'profile',
  infoPaneEl: null,
  libraryDialogSeen: false,
  bypassCapture: false,
  swipeSuppressedUntil: -Infinity,
  profileEl: null,
  profileState: new Map(),
};

export function isPhone() {
  return document.documentElement.classList.contains('grokbot-phone');
}

function setScreen(screen) {
  phone.screen = screen;
  const classes = document.documentElement.classList;
  classes.toggle('grokbot-view-chat', screen === 'chat');
  classes.toggle('grokbot-view-list', screen === 'list');
  if (screen === 'chat') phone.shownAt = performance.now();
  else {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.sand-chat')) active.blur();
  }
}

/** Shows the conversation screen (a Bot was opened, for example from a notification). */
export function showConversation() {
  setScreen('chat');
}

/** The back gesture in a conversation returns to the Bot list. */
export function phoneBack() {
  if (!isPhone() || phone.screen !== 'chat') return false;
  setScreen('list');
  return true;
}

function currentAgentId() {
  return document.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]')?.dataset.agentId ?? null;
}

function listedAgents() {
  return new Set([...document.querySelectorAll('.sand-agents-sidebar .sand-agent-item[data-agent-id]')].map(row => row.dataset.agentId));
}

function backButton() {
  if (phone.back) return phone.back;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'grokbot-nav-back';
  button.innerHTML = BACK_ICON;
  button.addEventListener('click', () => setScreen('list'));
  return phone.back = button;
}

function isZhLocale() {
  return (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('zh');
}

function profileStrings() {
  return isZhLocale() ? {
    back: '返回',
    share: '分享',
    more: '更多操作',
    edit: '编辑',
    routines: '定时任务',
    library: '资料库',
    computer: '电脑',
    notify: '通知',
    notifyCaption: 'Bot完成任务或等你处理时通知你',
    activeCount: n => `${n}已开启`,
    idle: '空闲',
  } : {
    back: 'Back',
    share: 'Share',
    more: 'More options',
    edit: 'Edit',
    routines: 'Routines',
    library: 'Library',
    computer: 'Computer',
    notify: 'Notifications',
    notifyCaption: 'Notify when this Bot finishes a task or needs your input',
    activeCount: n => `${n} active`,
    idle: 'Idle',
  };
}

function runBypassed(fn) {
  phone.bypassCapture = true;
  try { return fn(); }
  finally { phone.bypassCapture = false; }
}

function triggerClick(element) {
  if (!element) return;
  if (typeof PointerEvent === 'function') {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
    }));
  }
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
  if (typeof PointerEvent === 'function') {
    element.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0,
    }));
  }
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window }));
  element.click();
}

function openBotContextMenu() {
  const currentItem = document.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]');
  if (!currentItem) return false;
  currentItem.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: innerWidth - 28, clientY: 56, view: window,
  }));
  return true;
}

function getAgentProfileEntry(agentId) {
  let entry = phone.profileState.get(agentId);
  if (!entry) {
    let notify = true;
    try {
      const saved = localStorage.getItem(`grokbot.notify.${agentId}`);
      if (saved === 'false') notify = false;
    } catch {}
    entry = { notify, activeRoutines: null, loadedFor: '', loading: false };
    phone.profileState.set(agentId, entry);
  }
  return entry;
}

function countDomWorkflows(pane) {
  if (!pane) return null;
  const rows = pane.querySelectorAll('[data-automation-row], [data-workflow-id]');
  if (rows.length > 0) return rows.length;
  return null;
}

function refreshBotProfileData(agentId) {
  const api = globalThis.__grokbotProfile;
  if (!agentId || !api) return;
  const entry = getAgentProfileEntry(agentId);
  if (entry.loading || entry.loadedFor === agentId) return;
  entry.loading = true;
  Promise.all([
    api.getAgent?.(agentId).catch(() => null),
    api.getWorkflows?.(agentId).catch(() => null),
  ]).then(([agentRes, wfRes]) => {
    const agentObj = agentRes?.agent ?? agentRes;
    if (typeof agentObj?.notifyOnUpdatesEnabled === 'boolean') {
      entry.notify = agentObj.notifyOnUpdatesEnabled;
    }
    const list = Array.isArray(wfRes?.workflows) ? wfRes.workflows
      : Array.isArray(wfRes) ? wfRes : null;
    if (list) {
      entry.activeRoutines = list.filter(w => w && w.enabled !== false && w.paused !== true).length;
    }
    entry.loadedFor = agentId;
    entry.loading = false;
    renderBotProfile();
  }).catch(() => { entry.loading = false; });
}

function closeInfoPane() {
  const pane = document.querySelector('.sand-info-pane[data-open="true"]');
  if (!pane) return;
  runBypassed(() => {
    const backBtns = [...pane.querySelectorAll('.sand-info-pane__back button')];
    for (const btn of backBtns) btn.click();
    setTimeout(() => {
      runBypassed(() => {
        const stillOpen = document.querySelector('.sand-info-pane[data-open="true"]');
        if (!stillOpen) return;
        const closeBtn = [...stillOpen.querySelectorAll('.sand-info-pane__actions button')].pop();
        if (closeBtn) closeBtn.click();
        else document.querySelector('.sand-chat-header__identity')?.click();
      });
    }, backBtns.length > 0 ? 40 : 0);
  });
}

function waitForElement(finder, onFound, timeoutMs = 900) {
  const start = performance.now();
  const step = () => {
    const el = finder();
    if (el) { onFound(el); return; }
    if (performance.now() - start < timeoutMs) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function syncSubpageClasses() {
  const classes = document.documentElement.classList;
  const open = isPhone() && document.querySelector('.sand-info-pane[data-open="true"]') != null;
  classes.toggle('grokbot-subpage-routines', open && phone.infoMode === 'routines');
  classes.toggle('grokbot-subpage-computer', open && phone.infoMode === 'computer');
}

function openInfoSubpage(mode, { focusName = false } = {}) {
  const pane = document.querySelector('.sand-info-pane[data-open="true"]');
  if (!pane) return;
  phone.infoMode = mode;
  if (mode === 'library') phone.libraryDialogSeen = false;
  const keepHub = mode === 'library';
  document.documentElement.classList.toggle('grokbot-bot-profile-open', keepHub);
  syncSubpageClasses();
  if (phone.profileEl) phone.profileEl.hidden = !keepHub;

  const returnToOverview = () => {
    runBypassed(() => {
      const backBtn = pane.querySelector('.sand-info-pane__back button');
      if (backBtn) backBtn.click();
    });
  };

  if (mode === 'edit') {
    runBypassed(() => {
      const settingsRow = pane.querySelector('[data-info-row="settings"]');
      if (settingsRow) settingsRow.click();
    });
    if (focusName) {
      waitForElement(
        () => pane.querySelector('.sand-info-pane__section-content input'),
        input => { input.focus(); input.select?.(); },
      );
    }
    return;
  }

  if (mode === 'library') {
    const clickLibraryButton = () => {
      waitForElement(
        () => [...pane.querySelectorAll('button, [role="button"]')].find(
          btn => !btn.closest('.grokbot-bot-profile') && /library files|资料库/i.test(btn.textContent || ''),
        ),
        btn => runBypassed(() => btn.click()),
      );
    };
    const settingsRow = pane.querySelector('[data-info-row="settings"]');
    if (settingsRow) {
      runBypassed(() => settingsRow.click());
      clickLibraryButton();
    } else {
      clickLibraryButton();
    }
    return;
  }

  if (mode === 'computer' || mode === 'routines') {
    returnToOverview();
    waitForElement(
      () => !pane.querySelector('.sand-info-pane__back button')
        ? pane.querySelector('.sand-info-pane__section-content .ui-scroll-area__viewport, .sand-info-pane__section-content')
        : null,
      scroller => { scroller.scrollTop = 0; },
    );
  }
}

function ensureBotProfile(inner) {
  if (phone.profileEl && phone.profileEl.parentElement === inner) return phone.profileEl;
  const root = document.createElement('div');
  root.className = 'grokbot-bot-profile';
  root.hidden = true;
  root.innerHTML = `
    <div class="grokbot-bot-profile__topbar">
      <button type="button" class="grokbot-bot-profile__icon-btn grokbot-bot-profile__back">${BACK_ICON}</button>
      <div class="grokbot-bot-profile__right">
        <button type="button" class="grokbot-bot-profile__icon-btn grokbot-bot-profile__share">${SHARE_ICON}</button>
        <button type="button" class="grokbot-bot-profile__icon-btn grokbot-bot-profile__more">${MORE_ICON}</button>
      </div>
    </div>
    <div class="grokbot-bot-profile__hero">
      <div class="grokbot-bot-profile__avatar"></div>
      <h2 class="grokbot-bot-profile__name"></h2>
      <button type="button" class="grokbot-bot-profile__edit" data-profile-action="edit"></button>
    </div>
    <div class="grokbot-bot-profile__card">
      <button type="button" class="grokbot-bot-profile__row" data-profile-action="routines">
        <span class="grokbot-bot-profile__row-left">
          <span class="grokbot-bot-profile__row-icon">${CLOCK_ICON}</span>
          <span data-profile-label="routines"></span>
        </span>
        <span class="grokbot-bot-profile__row-right">
          <span data-profile-meta="routines"></span>
          ${CHEVRON_ICON}
        </span>
      </button>
      <button type="button" class="grokbot-bot-profile__row" data-profile-action="library">
        <span class="grokbot-bot-profile__row-left">
          <span class="grokbot-bot-profile__row-icon">${FOLDER_ICON}</span>
          <span data-profile-label="library"></span>
        </span>
        <span class="grokbot-bot-profile__row-right">${CHEVRON_ICON}</span>
      </button>
      <button type="button" class="grokbot-bot-profile__row" data-profile-action="computer">
        <span class="grokbot-bot-profile__row-left">
          <span class="grokbot-bot-profile__row-icon">${MONITOR_ICON}</span>
          <span data-profile-label="computer"></span>
        </span>
        <span class="grokbot-bot-profile__row-right">
          <span data-profile-meta="computer"></span>
          ${CHEVRON_ICON}
        </span>
      </button>
    </div>
    <div class="grokbot-bot-profile__card">
      <div class="grokbot-bot-profile__row" role="group">
        <span class="grokbot-bot-profile__row-left">
          <span data-profile-label="notify"></span>
        </span>
        <button type="button" role="switch" aria-checked="true" class="grokbot-bot-profile__switch" data-profile-toggle="notify">
          <span class="grokbot-bot-profile__switch-thumb"></span>
        </button>
      </div>
    </div>
    <p class="grokbot-bot-profile__caption"></p>
  `;

  root.querySelector('.grokbot-bot-profile__back').addEventListener('click', closeInfoPane);
  root.querySelector('.grokbot-bot-profile__share').addEventListener('click', () => {
    const controls = [...document.querySelectorAll('.sand-chat-header__controls button')];
    const target = controls[0];
    if (target) {
      triggerClick(target);
      setTimeout(() => {
        const hasOpen = document.querySelector('[role="menu"], [role="dialog"], [data-component="menu-positioner"]:not([data-closed])');
        if (!hasOpen && target.getAttribute('aria-expanded') !== 'true') {
          openBotContextMenu();
        }
      }, 60);
      return;
    }
    openBotContextMenu();
  });
  root.querySelector('.grokbot-bot-profile__more').addEventListener('click', () => {
    const controls = [...document.querySelectorAll('.sand-chat-header__controls button')];
    if (controls.length >= 2) { triggerClick(controls[1]); return; }
    if (!openBotContextMenu() && controls[0]) triggerClick(controls[0]);
  });
  for (const actionBtn of root.querySelectorAll('[data-profile-action]')) {
    actionBtn.addEventListener('click', () => openInfoSubpage(actionBtn.dataset.profileAction));
  }
  const notifySwitch = root.querySelector('[data-profile-toggle="notify"]');
  notifySwitch.addEventListener('click', () => {
    const agentId = phone.agent || currentAgentId();
    if (!agentId) return;
    const entry = getAgentProfileEntry(agentId);
    const prev = entry.notify;
    const next = !prev;
    entry.notify = next;
    notifySwitch.setAttribute('aria-checked', String(next));
    try { localStorage.setItem(`grokbot.notify.${agentId}`, String(next)); } catch {}
    const api = globalThis.__grokbotProfile;
    if (api?.setNotify) {
      api.setNotify(agentId, next).catch(() => {
        entry.notify = prev;
        notifySwitch.setAttribute('aria-checked', String(prev));
        try { localStorage.setItem(`grokbot.notify.${agentId}`, String(prev)); } catch {}
      });
    }
  });

  inner.append(root);
  phone.profileEl = root;
  return root;
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function renderBotProfile() {
  const pane = document.querySelector('.sand-info-pane[data-open="true"]');
  const inner = pane?.querySelector('.sand-info-pane__inner');
  const open = isPhone() && pane != null && inner != null;
  if (!open) {
    if (phone.infoOpen) {
      phone.infoOpen = false;
      phone.infoMode = 'profile';
      phone.infoPaneEl = null;
      phone.libraryDialogSeen = false;
    }
    document.documentElement.classList.remove('grokbot-bot-profile-open', 'grokbot-subpage-routines', 'grokbot-subpage-computer');
    if (phone.profileEl && !phone.profileEl.hidden) phone.profileEl.hidden = true;
    return;
  }
  if (!phone.infoOpen || phone.infoPaneEl !== pane) {
    phone.infoOpen = true;
    phone.infoMode = 'profile';
    phone.infoPaneEl = pane;
    phone.libraryDialogSeen = false;
    const agentId = phone.agent || currentAgentId();
    if (agentId) {
      const entry = getAgentProfileEntry(agentId);
      entry.loadedFor = '';
      refreshBotProfileData(agentId);
    }
  }
  if (phone.infoMode === 'library') {
    const libDialog = [...document.querySelectorAll('[role="dialog"]')].find(
      d => /library files|shared files|资料库/i.test(d.textContent || ''),
    );
    if (libDialog) {
      phone.libraryDialogSeen = true;
    } else if (phone.libraryDialogSeen) {
      phone.libraryDialogSeen = false;
      phone.infoMode = 'profile';
      runBypassed(() => pane.querySelector('.sand-info-pane__back button')?.click());
    }
  }
  const root = ensureBotProfile(inner);
  const showHub = phone.infoMode === 'profile' || phone.infoMode === 'library';
  document.documentElement.classList.toggle('grokbot-bot-profile-open', showHub);
  syncSubpageClasses();
  if (root.hidden === showHub) root.hidden = !showHub;
  if (!showHub) return;

  const s = profileStrings();
  const title = document.querySelector('.sand-chat-header__title')?.textContent?.trim() || 'Bot';
  setAttr(root.querySelector('.grokbot-bot-profile__back'), 'aria-label', s.back);
  setAttr(root.querySelector('.grokbot-bot-profile__share'), 'aria-label', s.share);
  setAttr(root.querySelector('.grokbot-bot-profile__more'), 'aria-label', s.more);
  setText(root.querySelector('.grokbot-bot-profile__name'), title);
  setText(root.querySelector('.grokbot-bot-profile__edit'), s.edit);
  setText(root.querySelector('[data-profile-label="routines"]'), s.routines);
  setText(root.querySelector('[data-profile-label="library"]'), s.library);
  setText(root.querySelector('[data-profile-label="computer"]'), s.computer);
  setText(root.querySelector('[data-profile-label="notify"]'), s.notify);
  setText(root.querySelector('.grokbot-bot-profile__caption'), s.notifyCaption);

  const avatarSlot = root.querySelector('.grokbot-bot-profile__avatar');
  const headerAvatar = document.querySelector('.sand-chat-header__avatar > *, .sand-chat-header__avatar');
  if (headerAvatar) {
    const key = headerAvatar.outerHTML.slice(0, 120) + title;
    if (avatarSlot.dataset.key !== key) {
      avatarSlot.dataset.key = key;
      const clone = headerAvatar.cloneNode(true);
      clone.removeAttribute?.('style');
      for (const el of clone.querySelectorAll?.('[style]') ?? []) el.removeAttribute('style');
      avatarSlot.replaceChildren(clone);
    }
  }

  const agentId = phone.agent || currentAgentId();
  const entry = agentId ? getAgentProfileEntry(agentId) : null;
  const domCount = countDomWorkflows(pane);
  const routineCount = entry?.activeRoutines ?? domCount;
  setText(
    root.querySelector('[data-profile-meta="routines"]'),
    typeof routineCount === 'number' ? s.activeCount(routineCount) : '',
  );

  const computerText = pane.querySelector('[class*="computer"] [class*="status"], .sand-computer-card__status')?.textContent?.trim() || s.idle;
  setText(root.querySelector('[data-profile-meta="computer"]'), computerText);

  setAttr(root.querySelector('[data-profile-toggle="notify"]'), 'aria-checked', String(entry ? entry.notify !== false : true));
}

function updatePhone() {
  const chat = document.querySelector('.sand-chat');
  const button = backButton();
  setAttr(button, 'aria-label', isZhLocale() ? '返回' : 'Back');
  if (chat && button.parentElement !== chat) chat.append(button);

  const current = currentAgentId(), listed = listedAgents(), now = performance.now();
  if (current !== phone.agent) {
    const previous = phone.agent;
    phone.agent = current;
    phone.infoMode = 'profile';
    const creating = current !== null && now - phone.creatingAt < 20000;
    const next = screenAfterAgentChange({ previous, current, screen: phone.screen,
      previousListed: previous == null || listed.has(previous), currentKnown: current == null || phone.known.has(current),
      userCaused: now - phone.interactedAt < 2000, creating });
    if (creating) phone.creatingAt = -Infinity;
    if (next !== phone.screen) setScreen(next);
    // A deleted Bot's row can stay in the list while it animates out; look again shortly.
    if (phone.screen === 'chat' && previous) {
      phone.deleted = { id: previous, until: now + 3000 };
      setTimeout(updatePhone, 1200);
    }
  }
  if (phone.deleted && (now > phone.deleted.until || phone.screen !== 'chat')) phone.deleted = null;
  if (phone.deleted && !listed.has(phone.deleted.id)) {
    phone.deleted = null;
    setScreen('list');
  }
  for (const id of listed) phone.known.add(id);
  // "New group chat" replaces the conversation with an empty one; show it.
  const newChat = document.querySelector('.sand-chat .sand-new-chat-stage') != null;
  if (newChat && !phone.newChat && now - phone.interactedAt < 2000) setScreen('chat');
  phone.newChat = newChat;

  // The details pane has no title of its own on its first page; show the Bot's name (or dedicated subpage title).
  const top = document.querySelector('.sand-info-pane[data-open="true"] .sand-info-pane__top');
  if (top) {
    const s = profileStrings();
    const title = top.querySelector('.sand-info-pane__subpage-title') ? ''
      : phone.infoMode === 'routines' ? s.routines
      : phone.infoMode === 'computer' ? s.computer
      : document.querySelector('.sand-chat-header__title')?.textContent?.trim() ?? '';
    if (title && top.dataset.grokbotTitle !== title) top.dataset.grokbotTitle = title;
    else if (!title && top.dataset.grokbotTitle !== undefined) delete top.dataset.grokbotTitle;
  }
  renderBotProfile();
  if (phone.screen === 'chat' && !current && !newChat && listed.size > 0 && now - phone.shownAt > 2000) {
    setScreen('list');
  }
  if (isPhone()) {
    for (const element of [document.documentElement, document.body, chat, document.querySelector('.sand-virtual-transcript')]) {
      if (element && element.scrollLeft !== 0) element.scrollLeft = 0;
    }
    for (const btn of document.querySelectorAll('.sand-agents-more-unreads')) {
      const label = formatMoreUnreadsLabel(btn.getAttribute('title'));
      if (label) {
        if (btn.dataset.grokbotLabel !== label) btn.dataset.grokbotLabel = label;
      } else if (btn.dataset.grokbotLabel !== undefined) {
        delete btn.dataset.grokbotLabel;
      }
    }
    addMarketplaceEntry();
  }
}

/**
 * The official phone app reaches the marketplace from the account sheet, and on a phone
 * android.css hides the marketplace button next to the account. While the account menu is
 * open it gets an entry that presses that button.
 */
function addMarketplaceEntry() {
  const account = document.querySelector('.sand-agents-sidebar__footer button[aria-haspopup="menu"][aria-expanded="true"]');
  const menu = account && document.getElementById(account.getAttribute('aria-controls'));
  if (!menu || menu.querySelector('.grokbot-marketplace-entry')) return;
  const marketplace = account.closest('.sand-agents-sidebar__footer').querySelector('button:not([aria-haspopup])');
  const template = [...menu.querySelectorAll('[role="menuitem"]')].find(item => !item.hasAttribute('aria-haspopup'));
  const label = marketplace?.textContent.trim();
  if (!label || !template) return;
  const entry = template.cloneNode(true);
  entry.removeAttribute('id');
  entry.classList.add('grokbot-marketplace-entry');
  entry.querySelector('[data-component="menu-item-content"]').textContent = label;
  const icon = entry.querySelector('.ui-icon'), source = marketplace.querySelector('.ui-icon');
  if (icon && source) {
    icon.dataset.iconName = source.dataset.iconName ?? '';
    icon.style.cssText = source.style.cssText;
  }
  entry.addEventListener('click', () => {
    account.click();
    marketplace.click();
  });
  menu.querySelector('[role^="menuitem"]').before(entry);
}

function dispatchHoverEdge(anchor, type) {
  if (!anchor?.isConnected) return;
  const entering = type === 'pointerenter';
  const bubblePointer = entering ? 'pointerover' : 'pointerout';
  const bubbleMouse = entering ? 'mouseover' : 'mouseout';
  const directMouse = entering ? 'mouseenter' : 'mouseleave';
  const relatedTarget = document.body;
  if (typeof PointerEvent === 'function') {
    anchor.dispatchEvent(new PointerEvent(bubblePointer, { bubbles: true, cancelable: false, pointerId: 1, pointerType: 'mouse', relatedTarget }));
    anchor.dispatchEvent(new PointerEvent(type, { bubbles: false, cancelable: false, pointerId: 1, pointerType: 'mouse', relatedTarget }));
  }
  anchor.dispatchEvent(new MouseEvent(bubbleMouse, { bubbles: true, cancelable: false, relatedTarget }));
  anchor.dispatchEvent(new MouseEvent(directMouse, { bubbles: false, cancelable: false, relatedTarget }));
}

function triggerSwipeReply(anchor) {
  if (!anchor?.isConnected) return;
  const root = document.documentElement;
  root.classList.add('grokbot-swipe-probing');
  dispatchHoverEdge(anchor, 'pointerenter');

  const cleanup = () => {
    dispatchHoverEdge(anchor, 'pointerleave');
    root.classList.remove('grokbot-swipe-probing');
  };

  const focusPrompt = () => {
    phone.fieldPointerAt = performance.now();
    const prompt = document.querySelector('.sand-prompt-form [contenteditable="true"], .sand-prompt-form textarea');
    if (prompt instanceof HTMLElement) prompt.focus({ preventScroll: true });
  };

  let frames = 0;
  const step = () => {
    const btn = findReplyActionButton(anchor);
    if (btn) {
      runBypassed(() => btn.click());
      cleanup();
      requestAnimationFrame(focusPrompt);
      return;
    }
    if (++frames < 12 && anchor.isConnected) {
      requestAnimationFrame(step);
      return;
    }
    // Fallback: open message context menu silently if hover toolbar wasn't mounted.
    const rect = anchor.getBoundingClientRect();
    anchor.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, buttons: 2,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, view: window,
    }));
    let menuFrames = 0;
    const pickMenuItem = () => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => REPLY_LABEL_RE.test(el.textContent || ''));
      if (item) {
        runBypassed(() => item.click());
        cleanup();
        requestAnimationFrame(focusPrompt);
        return;
      }
      if (++menuFrames < 8) requestAnimationFrame(pickMenuItem);
      else cleanup();
    };
    requestAnimationFrame(pickMenuItem);
  };
  requestAnimationFrame(step);
}

function canConsumeHorizontalSwipe(target, transcript) {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return true;
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), video, [role="slider"]')) return true;
  for (let node = target; node && node !== transcript; node = node.parentElement) {
    if (node.scrollWidth - node.clientWidth <= 1) continue;
    const overflowX = getComputedStyle(node).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollLeft < node.scrollWidth - node.clientWidth - 1) {
      return true;
    }
  }
  return false;
}

function installMessageSwipeReply() {
  let active = null;

  const clearVisuals = (anchor, badge, immediate) => {
    anchor.classList.remove('grokbot-swipe-dragging');
    anchor.style.removeProperty('--grokbot-swipe-drag');
    if (!badge) return;
    badge.classList.remove('grokbot-swipe-reply-badge--active', 'grokbot-swipe-reply-badge--ready');
    badge.style.opacity = '0';
    badge.style.transform = 'translateY(-50%) scale(0.55)';
    if (immediate) badge.remove();
    else setTimeout(() => { if (!badge.classList.contains('grokbot-swipe-reply-badge--active')) badge.remove(); }, 220);
  };

  addEventListener('touchstart', event => {
    active = null;
    if (!isPhone() || phone.screen !== 'chat' || paneLayerOpen() || computerStageOpen()) return;
    if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
    const transcript = event.target.closest('.sand-virtual-transcript');
    const anchor = event.target.closest('.sand-message-action-anchor');
    if (!transcript || !anchor || canConsumeHorizontalSwipe(event.target, transcript)) return;
    const touch = event.touches[0];
    active = {
      anchor,
      row: anchor.closest('.sand-transcript-row') || anchor.parentElement,
      startX: touch.clientX,
      startY: touch.clientY,
      locked: '',
      committed: false,
      thresholdReached: false,
      badge: null,
      replyChecked: false,
      replyAllowed: true,
    };
  }, { passive: true, capture: true });

  addEventListener('touchmove', event => {
    if (!active || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - active.startX;
    const dy = touch.clientY - active.startY;
    if (!active.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP_PX) return;
      if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        active.locked = 'x';
        document.documentElement.classList.add('grokbot-swipe-probing');
        dispatchHoverEdge(active.anchor, 'pointerenter');
        const state = active;
        requestAnimationFrame(() => {
          if (active !== state || !state.anchor.isConnected) return;
          if (state.anchor.querySelector('.sand-message-hover-actions')) {
            state.replyChecked = true;
            state.replyAllowed = findReplyActionButton(state.anchor) != null;
            if (!state.replyAllowed && state.badge) state.badge.style.display = 'none';
          }
        });
        if (active.row) {
          const badge = document.createElement('span');
          badge.className = 'grokbot-swipe-reply-badge grokbot-swipe-reply-badge--active';
          badge.setAttribute('aria-hidden', 'true');
          badge.innerHTML = REPLY_SWIPE_ICON;
          active.row.appendChild(badge);
          active.badge = badge;
        }
      } else {
        active = null;
        return;
      }
    }
    if (!active.replyAllowed) return;
    event.preventDefault();
    const drag = swipeReplyDisplacement(dx);
    const progress = Math.min(1, Math.max(0, (-dx - 6) / (SWIPE_TRIGGER_PX - 6)));
    active.anchor.classList.add('grokbot-swipe-dragging');
    active.anchor.style.setProperty('--grokbot-swipe-drag', `${drag.toFixed(1)}px`);
    const ready = -dx >= SWIPE_TRIGGER_PX;
    if (active.badge) {
      active.badge.style.opacity = String(progress);
      active.badge.style.transform = `translateY(-50%) scale(${(0.55 + 0.45 * progress).toFixed(3)})`;
      active.badge.classList.toggle('grokbot-swipe-reply-badge--ready', ready);
    }
    if (ready && !active.thresholdReached) {
      active.thresholdReached = true;
      try { navigator.vibrate?.(10); } catch {}
    } else if (!ready) {
      active.thresholdReached = false;
    }
    active.committed = ready;
  }, { passive: false, capture: true });

  const finish = event => {
    if (!active) return;
    const state = active;
    active = null;
    if (state.locked !== 'x') {
      document.documentElement.classList.remove('grokbot-swipe-probing');
      return;
    }
    const committed = event.type === 'touchend' && state.committed && state.replyAllowed;
    clearVisuals(state.anchor, state.badge, event.type === 'touchcancel');
    if (committed) {
      phone.swipeSuppressedUntil = performance.now() + 250;
      triggerSwipeReply(state.anchor);
    } else {
      dispatchHoverEdge(state.anchor, 'pointerleave');
      setTimeout(() => { if (!active) document.documentElement.classList.remove('grokbot-swipe-probing'); }, 16);
    }
  };

  addEventListener('touchend', finish, { passive: true, capture: true });
  addEventListener('touchcancel', finish, { passive: true, capture: true });
}

function installPhone() {
  phone.query = matchMedia(PHONE_QUERY);
  const apply = () => {
    document.documentElement.classList.toggle('grokbot-phone', phone.query.matches);
    setScreen(phone.screen);
  };
  phone.query.addEventListener('change', apply);
  apply();
  installMessageSwipeReply();

  addEventListener('click', event => {
    if (!isPhone() || !(event.target instanceof Element)) return;
    if (!phone.bypassCapture && phone.swipeSuppressedUntil > performance.now() && event.target.closest('.sand-virtual-transcript')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.closest('.sand-chat-header__identity')) {
      phone.infoMode = 'profile';
      phone.libraryDialogSeen = false;
      requestAnimationFrame(renderBotProfile);
    }
    if (phone.infoOpen && phone.infoMode === 'profile') {
      const renameItem = event.target.closest('[role="menuitem"]');
      if (renameItem && /rename|重命名/i.test(renameItem.textContent || '')) {
        event.preventDefault();
        event.stopPropagation();
        const menuTarget = renameItem.closest('[role="menu"], [data-component="menu-popup"]') || document.activeElement || document;
        for (const type of ['keydown', 'keyup']) {
          menuTarget.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        }
        openInfoSubpage('edit', { focusName: true });
        return;
      }
    }
    if (!phone.bypassCapture && phone.infoMode !== 'profile') {
      const subpageBack = event.target.closest('.sand-info-pane__back button')
        || event.target.closest('.sand-info-pane__top:not(:has(.sand-info-pane__back)) .sand-info-pane__actions > button:last-child');
      if (subpageBack) {
        event.preventDefault();
        event.stopPropagation();
        const prevMode = phone.infoMode;
        phone.infoMode = 'profile';
        if (prevMode === 'edit' || prevMode === 'library') {
          runBypassed(() => {
            const pane = document.querySelector('.sand-info-pane[data-open="true"]');
            pane?.querySelector('.sand-info-pane__back button')?.click();
            if (prevMode === 'library') {
              setTimeout(() => runBypassed(() => {
                document.querySelector('.sand-info-pane[data-open="true"] .sand-info-pane__back button')?.click();
              }), 40);
            }
          });
        }
        renderBotProfile();
        return;
      }
    }
    // "Create" in the new Bot sheet: the new Bot's conversation opens once the Host has made it.
    if (event.target.closest('.sand-create-bot-dialog > :last-child > button[data-variant="primary"]'))
      phone.creatingAt = performance.now();
    // A Bot opened from the list or from search shows its conversation.
    if (event.target.closest('.sand-agents-sidebar .sand-agent-item')
      || event.target.closest('.sand-command-palette [role="option"]')?.querySelector('.sand-kit-base-avatar, .sand-grok-bot-mark'))
      setScreen('chat');
  }, true);
  for (const type of ['pointerup', 'keydown'])
    addEventListener(type, () => { phone.interactedAt = performance.now(); }, true);
  addEventListener('pointerdown', event => {
    if (event.target instanceof Element && event.target.closest('textarea, input, [contenteditable="true"]'))
      phone.fieldPointerAt = performance.now();
  }, true);
  // Opening a conversation should not raise the keyboard: the desktop interface focuses the
  // message field when a Bot is selected. A tap on the field itself still focuses it.
  addEventListener('focusin', event => {
    if (!isPhone() || phone.screen !== 'chat' || !(event.target instanceof HTMLElement)) return;
    if (!event.target.closest('.sand-chat') || !event.target.matches('textarea, input, [contenteditable="true"]')) return;
    const now = performance.now();
    if (now - phone.shownAt < 800 && now - phone.fieldPointerAt > 800) event.target.blur();
  }, true);
}

export function installLayoutFixes() {
  let scheduled = false;
  installPhone();
  // The desktop interface hands focus back to the message field, for example after the
  // large computer view closes. Under the pane layer that field is out of sight, and on a
  // phone a focused field also raises the keyboard; so nothing covered keeps the focus.
  const releaseCoveredFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.sand-chat') && paneLayerOpen()) active.blur();
  };
  const run = () => {
    scheduled = false;
    fitAttachmentFrames();
    // Enter sends the message, as on the desktop; the on-screen keyboard labels the key that way.
    const prompt = document.querySelector('.sand-prompt-form [contenteditable="true"]');
    if (prompt && prompt.getAttribute('enterkeyhint') !== 'send') prompt.setAttribute('enterkeyhint', 'send');
    // android.css moves the details pane layer aside while the large computer view is open.
    document.documentElement.classList.toggle('grokbot-computer-stage', computerStageOpen());
    releaseCoveredFocus();
    updatePhone();
  };
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(run); } };
  new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.attributeName === 'data-open' && m.target instanceof Element && m.target.classList.contains('sand-info-pane')) {
        if (m.target.getAttribute('data-open') !== 'true') {
          phone.infoOpen = false;
          phone.infoMode = 'profile';
          phone.libraryDialogSeen = false;
        }
      }
    }
    if (mutations.every(m => m.target instanceof Element && m.target.closest('.grokbot-bot-profile'))) return;
    schedule();
  }).observe(document.documentElement,
    { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'aria-current', 'data-open', 'title'] });
  addEventListener('resize', schedule);
  addEventListener('focusin', schedule, true);
  schedule();
}
