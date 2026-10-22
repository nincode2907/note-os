import { createTiptapEditor, canonicalDocumentFromTiptapJSON, validateCanonicalDocument, toTiptapJSON } from '../../web/packages/document-engine/src/index.js';

(() => {
  const BRIDGE_VERSION = 1;
  const MAX_CHARS = 2 * 1024 * 1024;
  const root = document.getElementById('noteos-editor');
  const editorElement = document.getElementById('editable');
  const errorElement = document.getElementById('error');
  let editor = null;
  let sessionId = '';
  let outgoingGeneration = 0;
  let incomingGeneration = 0;
  let pendingSnapshotRequest = null;
  let compositionActive = false;
  let editable = false;

  function send(type, payload = {}) {
    if (!sessionId || !window.ReactNativeWebView?.postMessage) return;
    const json = JSON.stringify({ v: BRIDGE_VERSION, sessionId, generation: ++outgoingGeneration, type, payload });
    if (json.length <= MAX_CHARS) window.ReactNativeWebView.postMessage(json);
  }
  function currentDocument() {
    if (!editor) throw new Error('The editor has not finished opening.');
    const result = canonicalDocumentFromTiptapJSON(editor.getJSON());
    if (result.status !== 'supported') throw new Error(result.issues?.[0]?.message ?? 'This document is outside Canonical v1.');
    return result.document;
  }
  function reportHeight() {
    const height = Math.ceil(Math.max(root.scrollHeight, document.documentElement.scrollHeight));
    send('EDITOR_LAYOUT', { height: Math.max(240, Math.min(height, 16000)) });
  }
  function sendSnapshot(id) { send('DOCUMENT_SNAPSHOT', { document: currentDocument(), requestId: id }); }
  function flushPendingSnapshot() {
    if (!pendingSnapshotRequest || !editor || compositionActive || editor.view.composing) return;
    const id = pendingSnapshotRequest; pendingSnapshotRequest = null;
    try { sendSnapshot(id); } catch (error) { showError(error); }
  }
  function showError(error) {
    errorElement.hidden = false;
    errorElement.textContent = error instanceof Error ? error.message : 'The document could not be opened safely.';
    send('EDITOR_ERROR', { code: 'document-open', message: errorElement.textContent.slice(0, 1000) });
  }
  function setEditable(value) {
    editable = value === true;
    if (editor) editor.setEditable(editable);
    document.querySelectorAll('[data-command]').forEach(button => { button.disabled = !editable; });
  }
  function init(payload) {
    if (!payload || typeof payload.editable !== 'boolean') throw new Error('The initialization request is malformed.');
    const result = toTiptapJSON(payload.document);
    if (result.status !== 'ready') throw new Error(result.validation.issues?.[0]?.message ?? 'This document is preserved read-only.');
    if (editor) editor.destroy();
    errorElement.hidden = true;
    editable = payload.editable;
    editor = createTiptapEditor({
      element: editorElement,
      document: payload.document,
      editable,
      onUpdate: canonical => { try { send('DOCUMENT_CHANGED', { document: canonical }); reportHeight(); } catch (error) { showError(error); } },
    });
    editor.on('focus', () => send('EDITOR_FOCUS_CHANGED', { focused: true }));
    editor.on('blur', () => send('EDITOR_FOCUS_CHANGED', { focused: false }));
    editorElement.addEventListener('compositionstart', () => { compositionActive = true; }, true);
    editorElement.addEventListener('compositionend', () => window.setTimeout(() => { compositionActive = false; flushPendingSnapshot(); }, 0), true);
    document.querySelectorAll('[data-command]').forEach(button => { button.disabled = !editable; });
    send('EDITOR_READY', { editable });
    reportHeight();
  }
  function validateNativeMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.v !== BRIDGE_VERSION || !Number.isSafeInteger(message.generation) || message.generation <= incomingGeneration || typeof message.sessionId !== 'string' || typeof message.type !== 'string' || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new Error('Native editor command is malformed or stale.');
    if (message.sessionId.length < 1 || message.sessionId.length > 160 || !['INIT_DOCUMENT', 'SET_EDITABLE', 'REQUEST_DOCUMENT', 'SAVE_RESULT', 'FOCUS_BODY'].includes(message.type)) throw new Error('Native editor command type or session is invalid.');
    if (message.type !== 'INIT_DOCUMENT' && message.sessionId !== sessionId) throw new Error('Native editor command belongs to a different note.');
    if (JSON.stringify(message).length > MAX_CHARS) throw new Error('Native editor command exceeds the size limit.');
    const keys = Object.keys(message.payload).sort().join(',');
    const expected = { INIT_DOCUMENT: 'document,editable', SET_EDITABLE: 'editable', REQUEST_DOCUMENT: 'requestId', SAVE_RESULT: 'message,ok,requestId,revision', FOCUS_BODY: '' }[message.type];
    if (keys !== expected) throw new Error('Native editor command payload is invalid.');
    if (message.type === 'INIT_DOCUMENT' && typeof message.payload.editable !== 'boolean') throw new Error('Editor editability is invalid.');
    if (message.type === 'SET_EDITABLE' && typeof message.payload.editable !== 'boolean') throw new Error('Editor editability is invalid.');
    if (message.type === 'REQUEST_DOCUMENT' && (typeof message.payload.requestId !== 'string' || message.payload.requestId.length > 100)) throw new Error('Snapshot request ID is invalid.');
    if (message.type === 'SAVE_RESULT' && (typeof message.payload.requestId !== 'string' || message.payload.requestId.length > 100 || typeof message.payload.ok !== 'boolean' || !Number.isSafeInteger(message.payload.revision) || typeof message.payload.message !== 'string' || message.payload.message.length > 500)) throw new Error('Save result is invalid.');
    if (message.type === 'INIT_DOCUMENT' && validateCanonicalDocument(message.payload.document).status !== 'supported') throw new Error('Unsupported canonical documents remain read-only.');
    return message;
  }
  function receive(event) {
    let message;
    try { message = validateNativeMessage(JSON.parse(event.nativeEvent?.data ?? event.data)); }
    catch (error) { showError(error); return; }
    incomingGeneration = message.generation;
    if (message.type === 'INIT_DOCUMENT') {
      if (!message.sessionId || message.sessionId.length > 160 || !Number.isSafeInteger(message.payload.document?.schemaVersion)) { showError(new Error('The document initialization is invalid.')); return; }
      sessionId = message.sessionId;
      outgoingGeneration = 0;
      pendingSnapshotRequest = null;
      try { init(message.payload); } catch (error) { showError(error); }
      return;
    }
    try {
      switch (message.type) {
        case 'SET_EDITABLE':
          if (Object.keys(message.payload).join(',') !== 'editable' || typeof message.payload.editable !== 'boolean') throw new Error('Editability command is invalid.');
          setEditable(message.payload.editable);
          break;
        case 'REQUEST_DOCUMENT': {
          if (Object.keys(message.payload).join(',') !== 'requestId' || typeof message.payload.requestId !== 'string' || message.payload.requestId.length > 100) throw new Error('Snapshot request is invalid.');
          if (compositionActive || editor?.view.composing) pendingSnapshotRequest = message.payload.requestId;
          else sendSnapshot(message.payload.requestId);
          break;
        }
        case 'SAVE_RESULT':
          if (Object.keys(message.payload).sort().join(',') !== 'message,ok,requestId,revision' || typeof message.payload.requestId !== 'string' || typeof message.payload.ok !== 'boolean' || !Number.isSafeInteger(message.payload.revision) || typeof message.payload.message !== 'string' || message.payload.message.length > 500) throw new Error('Save result is invalid.');
          document.getElementById('save-state').textContent = message.payload.message;
          break;
        case 'FOCUS_BODY':
          if (Object.keys(message.payload).length) throw new Error('Focus command is invalid.');
          editor?.commands.focus();
          break;
        default: throw new Error('Unknown native editor command.');
      }
    } catch (error) { showError(error); }
  }

  window.addEventListener('message', receive);
  window.addEventListener('resize', reportHeight);
  new ResizeObserver(reportHeight).observe(root);
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (!button || !editor || !editable) return;
    const chain = editor.chain().focus();
    switch (button.dataset.command) {
      case 'bold': chain.toggleBold().run(); break;
      case 'italic': chain.toggleItalic().run(); break;
      case 'strike': chain.toggleStrike().run(); break;
      case 'heading': chain.toggleHeading({ level: Number(button.dataset.level) || 1 }).run(); break;
      case 'bullet': chain.toggleBulletList().run(); break;
      case 'ordered': chain.toggleOrderedList().run(); break;
      case 'task': chain.toggleTaskList().run(); break;
      case 'quote': chain.toggleBlockquote().run(); break;
      case 'code': chain.toggleCodeBlock().run(); break;
      case 'link': {
        const href = window.prompt('Link address (https, http, mailto or tel)');
        if (href === null) return;
        if (!/^(https?:|mailto:|tel:)/i.test(href)) { showError(new Error('Links must use http, https, mailto, or tel.')); return; }
        chain.setLink({ href }).run();
        break;
      }
    }
  });
  window.noteOSEditorReceive = raw => receive({ nativeEvent: { data: raw } });
})();
