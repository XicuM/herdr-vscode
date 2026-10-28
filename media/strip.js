(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('tabs');

  let state = { tabs: [] };
  // A drag or a rename in progress must not be re-rendered away from under the user.
  let busy = false;
  let dirty = false;
  let blocked = new Set();
  let lastActive;

  const post = (message) => vscode.postMessage(message);

  function settle() {
    busy = false;
    if (dirty) render();
  }

  function startRename(el, tab) {
    const label = el.querySelector('.label');
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = tab.label;
    input.setAttribute('aria-label', 'Tab name');
    label.replaceWith(input);
    busy = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (commit && name && name !== tab.label) post({ cmd: 'rename', id: tab.tab_id, label: name });
      // Re-render restores the label; if the rename succeeded the next state carries the new one.
      busy = false;
      render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  function clearDrop() {
    for (const el of list.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  }

  function tabElement(tab) {
    const active = tab.tab_id === state.activeId;
    const el = document.createElement('div');
    el.className = `tab status-${tab.status}${active ? ' active' : ''}`;
    el.dataset.id = tab.tab_id;
    // Native right-click menu: contributed under `webview/context` in package.json.
    el.dataset.vscodeContext = JSON.stringify({
      webviewSection: 'tab',
      tabId: tab.tab_id,
      isAgent: !!tab.agent,
      preventDefaultContextMenuItems: true
    });
    el.draggable = true;
    el.tabIndex = 0;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(active));
    el.setAttribute('aria-label', `${tab.label}, ${tab.status}${active ? ', active' : ''}`);
    el.title = `${tab.label} (${tab.agent || 'shell'}, ${tab.status})`;

    const glyph = document.createElement('span');
    const name = (tab.agent || '').toLowerCase();
    const logo = AGENT_LOGOS.find((l) => l.names.some((n) => name.includes(n)));
    glyph.className = logo ? 'glyph logo' : tab.agent ? 'glyph' : 'glyph shell';
    if (logo) {
      glyph.appendChild(new DOMParser().parseFromString(logo.svg, 'image/svg+xml').documentElement);
    } else {
      glyph.textContent = tab.agent ? tab.agent[0].toUpperCase() + (tab.agent[1] || '') : '>_';
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.label;

    const close = document.createElement('span');
    close.className = 'close';
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `Close ${tab.label}`);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      post({ cmd: 'close', id: tab.tab_id });
    });

    el.append(glyph, label, close);

    el.addEventListener('click', () => post({ cmd: 'open', id: tab.tab_id }));
    el.addEventListener('dblclick', () => startRename(el, tab));
    // Middle-click closes, as in browsers and editors.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) post({ cmd: 'close', id: tab.tab_id });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        post({ cmd: 'open', id: tab.tab_id });
      } else if (e.key === 'F2') {
        startRename(el, tab);
      } else if (e.key === 'Delete') {
        post({ cmd: 'close', id: tab.tab_id });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = e.key === 'ArrowRight' ? el.nextElementSibling : el.previousElementSibling;
        if (next && next.classList.contains('tab')) {
          e.preventDefault();
          next.focus();
        }
      }
    });

    el.addEventListener('dragstart', (e) => {
      busy = true;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.tab_id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearDrop();
      settle();
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      clearDrop();
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const id = e.dataTransfer.getData('text/plain');
      clearDrop();
      if (id) post({ cmd: 'reorder', id, target: tab.tab_id, before: e.clientX < rect.left + rect.width / 2 });
    });

    return el;
  }

  function render() {
    dirty = false;
    list.textContent = '';
    if (state.offline) {
      const note = document.createElement('span');
      note.className = 'empty';
      note.textContent = 'Herdr is offline';
      note.title = state.offline;
      list.append(note);
    } else if (state.tabs.length === 0) {
      const note = document.createElement('span');
      note.className = 'empty';
      note.textContent = 'No tabs. Double-click here to open one';
      list.append(note);
    }
    for (const tab of state.tabs) list.append(tabElement(tab));

    // Bring a tab into view when it starts waiting for you, or when the active tab changes.
    const nowBlocked = new Set(state.tabs.filter((t) => t.status === 'blocked').map((t) => t.tab_id));
    const fresh = [...nowBlocked].find((id) => !blocked.has(id));
    blocked = nowBlocked;
    const target = fresh
      ? list.querySelector(`[data-id="${CSS.escape(fresh)}"]`)
      : state.activeId !== lastActive && list.querySelector('.active');
    lastActive = state.activeId;
    if (target) target.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  // Terminal: colours and font come from VS Code's own terminal settings.
  const css = (name, fallback) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  function termTheme() {
    const theme = {
      background: css('--vscode-terminal-background', css('--vscode-panel-background', '#1e1e1e')),
      foreground: css('--vscode-terminal-foreground', '#cccccc'),
      cursor: css('--vscode-terminalCursor-foreground', '#cccccc'),
      selectionBackground: css('--vscode-terminal-selectionBackground', '#264f78')
    };
    for (const n of ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White']) {
      theme[n[0].toLowerCase() + n.slice(1)] = css(`--vscode-terminal-ansi${n}`, undefined);
      theme[`bright${n}`] = css(`--vscode-terminal-ansiBright${n}`, undefined);
    }
    return theme;
  }

  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: true,
    fontFamily: css('--vscode-editor-font-family', 'monospace'),
    fontSize: parseInt(css('--vscode-editor-font-size', '13'), 10) || 13,
    theme: termTheme()
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));

  term.onData((data) => post({ cmd: 'input', data }));
  // The pane is rendered by herdr, so scrolling is herdr's.
  term.attachCustomWheelEventHandler((e) => {
    post({ cmd: 'scroll', direction: e.deltaY < 0 ? 'up' : 'down', lines: 3 });
    return false;
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      post({ cmd: 'input', data: '\n' });
      return false;
    }
    return true;
  });

  let sizeTimer;
  function sendSize() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      fit.fit();
      post({ cmd: 'resize', cols: term.cols, rows: term.rows });
    }, 50);
  }
  new ResizeObserver(sendSize).observe(document.getElementById('term'));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'data') {
      term.write(Uint8Array.from(atob(m.bytes), (c) => c.charCodeAt(0)));
    } else if (m.type === 'reset') {
      term.reset();
    } else if (m.type === 'closed') {
      term.write(`\r\n\x1b[2m${m.reason}\x1b[0m\r\n`);
    } else if (m.type === 'state') {
      state = m.state;
      if (busy) dirty = true;
      else render();
    }
  });

  // Wheel scrolls the strip sideways when it is one row.
  list.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0 && list.scrollWidth > list.clientWidth) {
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // A double-click on empty space in the tab bar opens a new tab, as in VS Code's editor tabs.
  document.getElementById('bar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tab')) post({ cmd: 'new' });
  });
  // Dropping on the empty space after the last tab moves the dragged tab to the end, as in VS Code.
  list.addEventListener('dragover', (e) => {
    if (e.target !== list) return;
    e.preventDefault();
    clearDrop();
    list.lastElementChild?.classList.add('drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (e.target !== list) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const last = list.lastElementChild;
    clearDrop();
    if (id && last && last.dataset.id && last.dataset.id !== id) post({ cmd: 'reorder', id, target: last.dataset.id, before: false });
  });

  post({ cmd: 'ready' });
  sendSize();
})();
